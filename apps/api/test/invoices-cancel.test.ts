import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statementSchema, type Statement } from "@farooq/shared";
import { createHarness, customerBalanceSql, entriesFor, trialBalance, type Harness, type Session } from "./helpers/harness.js";
import { cancel, get, invBody, levelOf, mkPosted, movementSum, movementsOf, post, scenario, seedLegacyInvoice, seedProduct, seedStock } from "./helpers/invoices.js";

/**
 * Cancelling an invoice. Planner decision 1: a reversing INVOICE_CANCEL entry dated the invoice's OWN date (so the pair cancels
 * at every date); decision 4: stock back as SALE_REVERSAL_IN / INVOICE_CANCEL dated TODAY. Owner decision 1: refused while money
 * received against it stands. Base numbers: 10 bags × Rs 2,000 = 2,000,000 paisa on a godown of 100 bags; today is 2026-03-05.
 */
let h: Harness;
let owner: Session;
let sales: Session;
let accountant: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  sales = await h.session("SALES");
  accountant = await h.session("ACCOUNTANT");
});
afterAll(async () => {
  await h.close();
});

const statementOf = async (customerId: string, qs = ""): Promise<Statement> => {
  const res = await h.request(owner, "GET", `/customers/${customerId}/statement${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return statementSchema.parse(res.body);
};

describe("cancel — stock back today, journal reversed on the invoice's own date, number kept", () => {
  it("hand-computed: an invoice dated 2026-02-01 cancelled on 2026-03-05", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await mkPosted(h, owner, s, { extra: { date: "2026-02-01" } });
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(90_000);

    const r = await cancel(h, owner, inv.id, "customer changed his mind");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "CANCELLED", number: inv.number, stockApplied: false, cancelReason: "customer changed his mind", revision: 2, totalP: 2_000_000 });
    expect(r.body.cancelledAt).not.toBeNull();

    // stock: 10 bags back, dated TODAY (legacy), typed SALE_REVERSAL_IN / INVOICE_CANCEL
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe(100_000);
    expect((await movementsOf(h, inv.id)).map((m) => [m.kind, m.refType, m.q, m.ref, m.date, m.note])).toEqual([
      ["SALE_OUT", "INVOICE", -10_000, inv.number, "2026-02-01", s.shop.shopName],
      ["SALE_REVERSAL_IN", "INVOICE_CANCEL", 10_000, inv.number, "2026-03-05", "Invoice cancelled — customer changed his mind"],
    ]);

    // journal: the invoice's entry stays; a reversing entry is added, on the INVOICE'S date (not today)
    const original = await entriesFor(h.admin, "INVOICE", inv.id);
    const reversing = await entriesFor(h.admin, "INVOICE_CANCEL", inv.id);
    expect(original).toHaveLength(1);
    expect(reversing).toHaveLength(1);
    expect(reversing[0]).toMatchObject({ date: "2026-02-01", memo: `Cancelled sales invoice ${inv.number}`, created_by: owner.userId });
    expect(reversing[0]!.lines).toEqual([
      { code: "RECEIVABLES", party_type: "CUSTOMER", party_id: s.shop.id, debit: 0, credit: 2_000_000 },
      { code: "SALES", party_type: null, party_id: null, debit: 2_000_000, credit: 0 },
    ]);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0);
    // the pair cancels at every date: the balance at any date is what the legacy ledger (which skips a CANCELLED invoice) says
    const day = await h.admin`
      SELECT COALESCE(SUM(l.debit_p - l.credit_p), 0)::int AS b FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE a.code = 'RECEIVABLES' AND l.party_id = ${s.shop.id} AND e.date <= '2026-02-01'`;
    expect(day[0]!.b).toBe(0);

    const [aud] = await h.admin`SELECT action, before, after, actor_id FROM audit_log WHERE entity_id = ${inv.id} AND action = 'Invoice cancelled'`;
    expect(aud).toMatchObject({ action: "Invoice cancelled", actor_id: owner.userId });
    expect(aud!.before).toEqual({ status: "CONFIRMED", grandTotal: 2_000_000 });
    expect(aud!.after).toMatchObject({ status: "CANCELLED", reason: "customer changed his mind", ref: inv.number });
    const tb = await trialBalance(h.admin);
    expect(tb.debit).toBe(tb.credit);
  });

  it("the statement leaves out BOTH entries of a cancelled invoice and counts it in `omittedCancelled` (only when dated inside the window)", async () => {
    const s = await scenario(h);
    await h.seed.invoice(s.shop.id, { date: "2026-01-10", totalP: 70_000 });
    const inv = await mkPosted(h, owner, s, { qty: 5, unitPriceP: 10_000, extra: { date: "2026-02-01" } });
    await cancel(h, owner, inv.id);
    const st = await statementOf(s.shop.id);
    expect(st.rows.map((r) => r.ref)).toHaveLength(1);
    expect(st.rows.some((r) => r.ref === inv.number)).toBe(false);
    expect(st.omittedCancelled).toBe(1);
    expect(st.closing).toBe(70_000);
    expect(st.omittedReversed).toBe(0);
    expect((await statementOf(s.shop.id, "?from=2026-02-15")).omittedCancelled).toBe(0);
    expect((await statementOf(s.shop.id, "?to=2026-01-31")).omittedCancelled).toBe(0);
    expect((await statementOf(s.shop.id, "?from=2026-02-01&to=2026-02-01")).omittedCancelled).toBe(1);
  });

  it("stock comes back per PRODUCT × GODOWN, Σ qty: two lines of one product → ONE movement", async () => {
    const s = await scenario(h, { stock: 50 });
    const other = await seedProduct(h, { buyP: 1 });
    await seedStock(h, other.id, s.wh.id, 20);
    const inv = await post(
      h,
      owner,
      invBody(s.shop.id, s.wh.id, [
        { productId: s.product.id, quantity: 4, unitPriceP: 1_000 },
        { productId: s.product.id, quantity: 6, unitPriceP: 1_000 },
        { productId: other.id, quantity: 2.5, unitPriceP: 1_000 },
      ]),
    );
    expect(inv.status).toBe(201);
    await cancel(h, owner, inv.body.id);
    const back = (await movementsOf(h, inv.body.id)).filter((m) => m.kind === "SALE_REVERSAL_IN");
    expect(back.map((m) => [m.productId === s.product.id ? "p" : "o", m.q]).sort()).toEqual([["o", 2_500], ["p", 10_000]]);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(50_000);
    expect(await levelOf(h, other.id, s.wh.id)).toBe(20_000);
  });

  it("an invoice's status, number and lines are kept; a second cancel is refused; the invoice cannot be edited or paid afterwards", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await cancel(h, owner, inv.id);
    const again = await cancel(h, owner, inv.id);
    expect(again.status).toBe(422);
    expect(again.body.errors).toEqual(["This invoice is already cancelled."]);
    const cur = (await get(h, owner, inv.id)).body;
    expect(cur.lines).toHaveLength(1);
    // S3's rule still holds: a cancelled invoice is never collectable, explicitly or automatically
    const explicit = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 500, allocations: [{ invoiceId: inv.id, amountP: 500 }] } });
    expect(explicit.status).toBe(422);
    expect(explicit.body.errors[0]).toBe(`Invoice ${inv.number} is cancelled and cannot be paid.`);
  });

  it("the reason is required (the legacy defaulted to 'No reason given'; the plan asks for one)", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    for (const reason of ["", "   "]) {
      const r = await h.request(owner, "POST", `/invoices/${inv.id}/cancel`, { body: { reason } });
      expect(r.status).toBe(422);
      expect(r.body.errors).toEqual(["Enter a reason for cancelling this invoice."]);
    }
    expect((await h.request(owner, "POST", `/invoices/${inv.id}/cancel`, { body: {} })).status).toBe(422);
    expect((await get(h, owner, inv.id)).body.status).toBe("CONFIRMED");
    expect((await h.request(owner, "POST", "/invoices/00000000-0000-4000-8000-000000000000/cancel", { body: { reason: "x" } })).status).toBe(404);
  });
});

describe("cancel — refused while money received against the invoice stands (owner decision 1)", () => {
  it("lists the receipts and what to do; nothing changes; after the receipt is reversed the cancel goes through and the shop ends at 0", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    const before = await customerBalanceSql(h.admin, s.shop.id);
    const refused = await cancel(h, owner, inv.id);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([`Money has been received against this invoice (${inv.receipts[0].receiptNumber} — PKR 5,000). Reverse the receipt first, then cancel the invoice.`]);
    expect((await get(h, owner, inv.id)).body.status).toBe("PARTIALLY_PAID");
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(90_000);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(before);

    expect((await h.request(owner, "POST", `/payments/${inv.receipts[0].paymentId}/reverse`, { body: { reason: "cheque bounced" } })).status).toBe(200);
    const ok = await cancel(h, owner, inv.id);
    expect(ok.status).toBe(200);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0); // invoice + its cancel + receipt + its reversal
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000);
  });

  it("names every receipt when there are several", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 100_000 });
    const r2 = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 50_000, allocations: [{ invoiceId: inv.id, amountP: 50_000 }] } });
    const refused = await cancel(h, owner, inv.id);
    expect(refused.body.errors[0]).toContain(inv.receipts[0].receiptNumber);
    expect(refused.body.errors[0]).toContain(r2.body.receiptNumber);
  });
});

describe("cancel — refused with a return; drafts; migrated invoices", () => {
  it("a non-cancelled return blocks the cancel (restocking would double-count the returned bags — the legacy bug)", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 4, unitPriceP: 10_000 });
    await h.seed.customerReturn(s.shop.id, inv.id, { totalP: 10_000, number: "CR-5" });
    const r = await cancel(h, owner, inv.id);
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toContain("A return has been posted against this invoice (CR-5), so it cannot be cancelled");
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(96_000);
  });

  it("a draft is cancelled by marking it: no stock, no journal entry, no number", async () => {
    const s = await scenario(h);
    const d = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 3, unitPriceP: 1_000 }], { mode: "draft" }));
    const r = await cancel(h, owner, d.body.id, "not needed");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "CANCELLED", number: null });
    expect(await movementsOf(h, d.body.id)).toEqual([]);
    expect(await entriesFor(h.admin, "INVOICE_CANCEL", d.body.id)).toEqual([]);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000);
  });

  it("an invoice that came in through the importer (with its SALE_OUT movement) gets its bags back", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await seedLegacyInvoice(h, s, { qty: 4 });
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(96_000);
    expect((await cancel(h, owner, inv.id)).status).toBe(200);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe(100_000);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0);
  });

  it("a MIGRATED invoice posts no stock movement on cancel (nothing was ever taken), but its journal is still reversed", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await seedLegacyInvoice(h, s, { qty: 4, migrated: true });
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000);
    expect((await cancel(h, owner, inv.id)).status).toBe(200);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000);
    expect(await movementsOf(h, inv.id)).toEqual([]);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0);
  });
});

describe("cancel — who may (TRANSACTION_CORRECT for a posted invoice; SALES_CREATE or TRANSACTION_CORRECT for a draft)", () => {
  it("SALES cannot cancel a POSTED invoice (403, nothing changes, the message names the permission); the ACCOUNTANT can", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const no = await cancel(h, sales, inv.id);
    expect(no.status).toBe(403);
    expect(no.body.message).toBe("You do not have permission to edit a posted invoice, cancel it or change its shop.");
    expect((await get(h, owner, inv.id)).body.status).toBe("CONFIRMED");
    expect((await cancel(h, accountant, inv.id)).status).toBe(200);
  });

  it("SALES can discard a DRAFT (its own or another's): nothing but the status changes; the same person still cannot cancel it after posting", async () => {
    const s = await scenario(h);
    const d = await post(h, sales, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 3, unitPriceP: 1_000 }], { mode: "draft" }));
    const r = await cancel(h, sales, d.body.id, "wrong shop");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "CANCELLED", number: null, cancelReason: "wrong shop" });
    expect(await movementsOf(h, d.body.id)).toEqual([]);
    expect(await entriesFor(h.admin, "INVOICE_CANCEL", d.body.id)).toEqual([]);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000);
    // the draft the OWNER made can be discarded by SALES too
    const ownerDraft = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
    expect((await cancel(h, sales, ownerDraft.body.id)).status).toBe(200);
    // once posted, the door closes again
    const posted = await post(h, sales, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }]));
    expect(posted.status).toBe(201);
    expect((await cancel(h, sales, posted.body.id)).status).toBe(403);
    expect((await get(h, owner, posted.body.id)).body.status).toBe("CONFIRMED");
  });

  it("the discard rule does not open the other doors: INVENTORY is refused on a draft; SALES cannot discard an already-cancelled draft (403, not a refusal text)", async () => {
    const s = await scenario(h);
    const d = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
    const inventory = await h.session("INVENTORY");
    expect((await cancel(h, inventory, d.body.id)).status).toBe(403);
    expect((await get(h, owner, d.body.id)).body.status).toBe("DRAFT");
    expect((await cancel(h, owner, d.body.id)).status).toBe(200);
    expect((await cancel(h, sales, d.body.id)).status).toBe(403);
  });
});
