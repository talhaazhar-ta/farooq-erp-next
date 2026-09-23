import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, customerBalanceSql, entriesFor, invoiceStatus, supplierBalanceSql, type Harness, type Session } from "./helpers/harness.js";

/** reverse and editAmount — legacy `Payments.reverse / editAmountCheck / editAmount`. Hand-computed expectations, legacy wording verbatim. */
let h: Harness;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const receive = (customerId: string, amountP: number, extra: Record<string, unknown> = {}) =>
  h.request(owner, "POST", "/payments/receive", { body: { customerId, amountP, ...extra } });
const pay = (supplierId: string, amountP: number, extra: Record<string, unknown> = {}) =>
  h.request(owner, "POST", "/payments/pay", { body: { supplierId, amountP, ...extra } });
const refund = (customerId: string, amountP: number, extra: Record<string, unknown> = {}) =>
  h.request(owner, "POST", "/payments/refund", { body: { customerId, amountP, ...extra } });
const reverse = (id: string, reason: unknown = "entered in error") => h.request(owner, "POST", `/payments/${id}/reverse`, { body: { reason } });
const edit = (id: string, amountP: unknown, extra: Record<string, unknown> = {}) => h.request(owner, "POST", `/payments/${id}/edit-amount`, { body: { amountP, ...extra } });

describe("reverse", () => {
  it("an unknown or malformed id is a 404 with the legacy wording", async () => {
    const a = await reverse("00000000-0000-4000-8000-000000000000");
    expect(a.status).toBe(404);
    expect(a.body).toEqual({ message: "Payment not found.", errors: ["Payment not found."] });
    expect((await reverse("not-a-uuid")).status).toBe(404);
  });

  it("requires a non-empty reason", async () => {
    const c = await h.seed.customer();
    const r = await receive(c.id, 1_000);
    const attempts = [
      await reverse(r.body.id, ""),
      await reverse(r.body.id, "   "),
      await h.request(owner, "POST", `/payments/${r.body.id}/reverse`, { body: {} }), // reason missing altogether
    ];
    for (const res of attempts) {
      expect(res.status).toBe(422);
      expect(res.body.message).toBe("Enter a reason.");
    }
    expect((await h.request(owner, "GET", `/payments/${r.body.id}`)).body.status).toBe("POSTED");
  });

  it("brings the shop's balance back to exactly what it was before the payment, and the entry pair nets to zero", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 1_000_000, number: "INV-V-1" });
    const paid = await receive(c.id, 600_000);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(400_000);
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PARTIALLY_PAID");

    const res = await reverse(paid.body.id, "wrong shop");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "REVERSED", reverseReason: "wrong shop", reversedBy: owner.userId });
    expect(res.body.reversedAt).not.toBeNull();

    // balance = pre-payment: 1,000,000
    expect(await customerBalanceSql(h.admin, c.id)).toBe(1_000_000);
    // exactly two entries for the voucher, the second the mirror of the first, so the pair nets to zero
    const original = await entriesFor(h.admin, "PAYMENT", paid.body.id);
    const reversal = await entriesFor(h.admin, "PAYMENT_REVERSAL", paid.body.id);
    expect(original).toHaveLength(1);
    expect(reversal).toHaveLength(1);
    expect(reversal[0]!.lines).toEqual([
      { code: "CASH", party_type: null, party_id: null, debit: 0, credit: 600_000 },
      { code: "RECEIVABLES", party_type: "CUSTOMER", party_id: c.id, debit: 600_000, credit: 0 },
    ]);
    const net = (es: typeof original) => es.flatMap((e) => e.lines).reduce((a, l) => a + l.debit - l.credit, 0);
    expect(net(original) + net(reversal)).toBe(0);
    expect(reversal[0]!.created_by).toBe(owner.userId);
  });

  it("KEEPS the allocation rows but the invoice's paid / outstanding / status are recomputed without them", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 1_000_000, number: "INV-V-2" });
    const paid = await receive(c.id, 1_000_000);
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PAID");

    await reverse(paid.body.id);
    const detail = await h.request(owner, "GET", `/payments/${paid.body.id}`);
    expect(detail.body.allocations.map((a: any) => [a.documentNumber, a.amountP])).toEqual([["INV-V-2", 1_000_000]]); // history kept
    expect(await invoiceStatus(h.admin, inv.id)).toBe("CONFIRMED");
    const out = await h.request(owner, "GET", `/customers/${c.id}/outstanding-invoices`);
    expect(out.body.map((r: any) => [r.number, r.paidP, r.outstandingP])).toEqual([["INV-V-2", 0, 1_000_000]]);
    // ...and the freed invoice can be paid again
    const again = await receive(c.id, 1_000_000);
    expect(again.body.allocations.map((a: any) => a.amountP)).toEqual([1_000_000]);
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PAID");
  });

  it("a second reverse of the same voucher is refused (stricter than the legacy) and posts nothing more", async () => {
    const c = await h.seed.customer();
    const r = await receive(c.id, 5_000);
    expect((await reverse(r.body.id)).status).toBe(200);
    const second = await reverse(r.body.id, "again");
    expect(second.status).toBe(422);
    expect(second.body).toEqual({ message: "This voucher is already reversed.", errors: ["This voucher is already reversed."] });
    expect(await entriesFor(h.admin, "PAYMENT_REVERSAL", r.body.id)).toHaveLength(1);
    const audits = await h.admin`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${r.body.id} AND action = 'Payment reversed'`;
    expect(audits[0]!.n).toBe(1);
  });

  it("the reversing entry carries the ORIGINAL payment's date even when reversed later (the pair cancels at every date)", async () => {
    const c = await h.seed.customer();
    const r = await receive(c.id, 5_000, { date: "2026-02-10" });
    h.clock.current = new Date("2026-03-20T06:00:00Z");
    try {
      const res = await reverse(r.body.id);
      expect(res.body.reversedAt).toBe("2026-03-20T06:00:00.000Z");
    } finally {
      h.clock.current = new Date("2026-03-05T06:00:00Z");
    }
    const [orig] = await entriesFor(h.admin, "PAYMENT", r.body.id);
    const [rev] = await entriesFor(h.admin, "PAYMENT_REVERSAL", r.body.id);
    expect(orig!.date).toBe("2026-02-10");
    expect(rev!.date).toBe("2026-02-10");
  });

  it("writes an audit row with the before-snapshot (allocations included) and the reason", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 100_000 });
    const r = await receive(c.id, 100_000);
    await reverse(r.body.id, "duplicate entry");
    const [a] = await h.admin`SELECT actor_id, before, after FROM audit_log WHERE entity_id = ${r.body.id} AND action = 'Payment reversed'`;
    expect(a!.actor_id).toBe(owner.userId);
    expect(a!.before).toMatchObject({ status: "POSTED", amountP: 100_000, allocations: [{ invoiceId: inv.id, purchaseId: null, amountP: 100_000 }] });
    expect(a!.after).toEqual({ status: "REVERSED", reason: "duplicate entry" });
  });

  it("a supplier payment: the supplier's balance goes back up by exactly the amount", async () => {
    const s = await h.seed.supplier();
    await h.seed.purchase(s.id, { totalP: 500_000 });
    const p = await pay(s.id, 200_000);
    expect(await supplierBalanceSql(h.admin, s.id)).toBe(300_000);
    await reverse(p.body.id);
    expect(await supplierBalanceSql(h.admin, s.id)).toBe(500_000);
  });

  it("a shop refund can be reversed; so can the refund voucher of a customer return (the legacy allows both)", async () => {
    const c = await h.seed.customer();
    const r = await refund(c.id, 40_000);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(40_000);
    expect((await reverse(r.body.id)).status).toBe(200);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(0);

    const tied = await h.seed.voucher({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 25_000, note: "Refund against return CR-V-1", reference: "CR-V-1" });
    await h.seed.customerReturn(c.id, null, { totalP: 25_000, number: "CR-V-1", treatment: "REFUND", refundPaymentId: tied.id });
    expect((await reverse(tied.id, "return corrected")).status).toBe(200);
  });
});

describe("editAmount — the eligibility refusals, in the legacy order, with the legacy wording", () => {
  const NOT_FOUND = "Payment not found.";
  const REVERSED = "A reversed voucher cannot be edited.";
  const WRONG_KIND = "Only a voucher paid to a shop or a supplier can have its amount corrected here.";
  const ALLOCATED = "This payment is applied to an invoice or purchase; its amount can’t be changed here.";
  const RETURN_REFUND = "This voucher is the refund for a customer return — correct the return instead.";

  it("not found → 404", async () => {
    const res = await edit("00000000-0000-4000-8000-000000000000", 100);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(NOT_FOUND);
  });

  it("refuses a REVERSED voucher", async () => {
    const c = await h.seed.customer();
    const r = await refund(c.id, 10_000);
    await reverse(r.body.id);
    const res = await edit(r.body.id, 20_000);
    expect(res.status).toBe(422);
    expect(res.body.message).toBe(REVERSED);
  });

  it("refuses an IN voucher (money received is not corrected here)", async () => {
    const c = await h.seed.customer();
    const r = await receive(c.id, 10_000);
    expect((await edit(r.body.id, 20_000)).body.message).toBe(WRONG_KIND);
  });

  it("REVERSED is checked before the kind: a reversed IN voucher says 'reversed'", async () => {
    const c = await h.seed.customer();
    const r = await receive(c.id, 10_000);
    await reverse(r.body.id);
    expect((await edit(r.body.id, 20_000)).body.message).toBe(REVERSED);
  });

  it("refuses a voucher that has any allocation (a supplier voucher paid with a purchase)", async () => {
    const s = await h.seed.supplier();
    const pur = await h.seed.purchase(s.id, { totalP: 100_000 });
    const p = await pay(s.id, 100_000, { allocations: [{ purchaseId: pur.id, amountP: 100_000 }] });
    expect((await edit(p.body.id, 50_000)).body.message).toBe(ALLOCATED);
    // the eligibility refusal wins over the amount check
    expect((await edit(p.body.id, 0)).body.message).toBe(ALLOCATED);
  });

  it("refuses the cash side of a customer return's REFUND treatment — tied by the FK alone", async () => {
    const c = await h.seed.customer();
    const v = await h.seed.voucher({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 30_000, note: "cash back", reference: "unrelated" });
    await h.seed.customerReturn(c.id, null, { totalP: 30_000, treatment: "REFUND", refundPaymentId: v.id });
    expect((await edit(v.id, 40_000)).body.message).toBe(RETURN_REFUND);
  });

  it("…and tied by the legacy heuristic alone (note prefix + reference == a customer return's number, no FK)", async () => {
    const c = await h.seed.customer();
    await h.seed.customerReturn(c.id, null, { totalP: 30_000, number: "CR-H-1", treatment: "REFUND", refundPaymentId: null });
    const v = await h.seed.voucher({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 30_000, note: "Refund against return CR-H-1", reference: "CR-H-1" });
    expect((await edit(v.id, 40_000)).body.message).toBe(RETURN_REFUND);
  });

  it("does NOT false-positive: only the prefix, or only a matching reference, is an ordinary voucher", async () => {
    const c = await h.seed.customer();
    await h.seed.customerReturn(c.id, null, { totalP: 1, number: "CR-H-2" });
    const prefixOnly = await h.seed.voucher({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 30_000, note: "Refund against return CR-NOPE", reference: "CR-NOPE" });
    const referenceOnly = await h.seed.voucher({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 30_000, note: "typed by hand", reference: "CR-H-2" });
    expect((await edit(prefixOnly.id, 31_000)).status).toBe(200);
    expect((await edit(referenceOnly.id, 31_000)).status).toBe(200);
  });

  it("the amount must be greater than zero and different from the current one (checked after eligibility)", async () => {
    const c = await h.seed.customer();
    const r = await refund(c.id, 10_000);
    for (const bad of [0, -5]) {
      const res = await edit(r.body.id, bad);
      expect(res.status).toBe(422);
      expect(res.body.message).toBe("Enter an amount greater than zero.");
    }
    expect((await edit(r.body.id, 10.5)).body.message).toBe("Enter an amount greater than zero.");
    expect((await edit(r.body.id, "12")).body.message).toBe("Enter an amount greater than zero.");
    expect((await edit(r.body.id, 10_000)).body.message).toBe("That is already the recorded amount.");
  });
});

describe("editAmount — corrects in place and the ledger moves by exactly the delta", () => {
  it("a shop voucher: 100,000 → 130,000 → 90,000 keeps ONE entry, and the balance follows each edit", async () => {
    const c = await h.seed.customer();
    await h.seed.invoice(c.id, { totalP: 500_000 }); // balance 500,000
    const r = await refund(c.id, 100_000); // refund raises the balance: 600,000
    expect(await customerBalanceSql(h.admin, c.id)).toBe(600_000);

    const e1 = await edit(r.body.id, 130_000, { reason: "typed 1,000 instead of 1,300" });
    expect(e1.status).toBe(200);
    expect(e1.body.amountP).toBe(130_000);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(630_000); // +30,000 = the delta

    await edit(r.body.id, 90_000);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(590_000); // -40,000

    const entries = await entriesFor(h.admin, "PAYMENT", r.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lines).toEqual([
      { code: "CASH", party_type: null, party_id: null, debit: 0, credit: 90_000 },
      { code: "RECEIVABLES", party_type: "CUSTOMER", party_id: c.id, debit: 90_000, credit: 0 },
    ]);
    expect(await entriesFor(h.admin, "PAYMENT_REVERSAL", r.body.id)).toHaveLength(0);

    const audits = await h.admin`SELECT before, after FROM audit_log WHERE entity_id = ${r.body.id} AND action = 'Payment amount corrected' ORDER BY at, id`;
    expect(audits).toHaveLength(2);
    const byBefore = new Map(audits.map((a) => [(a.before as any).amountP, a.after as any]));
    expect(byBefore.get(100_000)).toMatchObject({ amountP: 130_000, reason: "typed 1,000 instead of 1,300" });
    expect(byBefore.get(130_000)).toMatchObject({ amountP: 90_000, reason: null });
  });

  it("a supplier voucher: the supplier's balance moves by exactly the delta", async () => {
    const s = await h.seed.supplier();
    await h.seed.purchase(s.id, { totalP: 500_000 });
    const p = await pay(s.id, 200_000);
    expect(await supplierBalanceSql(h.admin, s.id)).toBe(300_000);
    await edit(p.body.id, 260_000);
    expect(await supplierBalanceSql(h.admin, s.id)).toBe(240_000); // we now owe 60,000 less
    expect((await entriesFor(h.admin, "PAYMENT", p.body.id))).toHaveLength(1);
  });

  it("works on an imported-style voucher too (a direct insert with its entry), keeping the trial balance intact", async () => {
    const c = await h.seed.customer();
    const v = await h.seed.voucher({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 100_000, note: "Refund to shop" });
    await edit(v.id, 120_000);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(120_000);
    const [t] = await h.admin`SELECT COALESCE(SUM(debit_p),0)::text AS d, COALESCE(SUM(credit_p),0)::text AS c FROM journal_lines`;
    expect(t!.d).toBe(t!.c);
  });

  it("the detail read tells the UI what may be done and why not (the same wording the write returns)", async () => {
    const c = await h.seed.customer();
    const inVoucher = await receive(c.id, 1_000);
    const plain = await refund(c.id, 1_000);
    const sales = await h.session("SALES");

    const a = (await h.request(owner, "GET", `/payments/${inVoucher.body.id}`)).body.actions;
    expect(a.reverse).toEqual({ allowed: true, reason: null });
    expect(a.editAmount).toEqual({ allowed: false, reason: "Only a voucher paid to a shop or a supplier can have its amount corrected here." });

    const b = (await h.request(owner, "GET", `/payments/${plain.body.id}`)).body.actions;
    expect(b).toEqual({ reverse: { allowed: true, reason: null }, editAmount: { allowed: true, reason: null } });

    // the caller's role matters: SALES may read (PAYMENT_CREATE) but holds no TRANSACTION_CORRECT
    const c2 = (await h.request(sales, "GET", `/payments/${plain.body.id}`)).body.actions;
    expect(c2.reverse.allowed).toBe(false);
    expect(c2.reverse.reason).toBe("You do not have permission to reverse a voucher.");
    expect(c2.editAmount.allowed).toBe(false);

    await reverse(plain.body.id);
    const d = (await h.request(owner, "GET", `/payments/${plain.body.id}`)).body.actions;
    expect(d.reverse).toEqual({ allowed: false, reason: "This voucher is already reversed." });
    expect(d.editAmount).toEqual({ allowed: false, reason: "A reversed voucher cannot be edited." });
  });
});
