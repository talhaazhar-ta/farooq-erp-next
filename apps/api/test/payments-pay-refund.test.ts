import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, customerBalanceSql, entriesFor, supplierBalanceSql, type Harness, type Session } from "./helpers/harness.js";

/** pay (money out to a supplier) and refund (money out to a shop) — legacy `Payments.pay / refund`. Hand-computed expectations. */
let h: Harness;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const pay = (supplierId: string, amountP: number, extra: Record<string, unknown> = {}) =>
  h.request(owner, "POST", "/payments/pay", { body: { supplierId, amountP, ...extra } });
const refund = (customerId: string, amountP: number, extra: Record<string, unknown> = {}) =>
  h.request(owner, "POST", "/payments/refund", { body: { customerId, amountP, ...extra } });

describe("pay — a supplier payment", () => {
  it("writes an OUT / SUPPLIER voucher numbered PV-<year>-…, DR PAYABLES / CR CASH, lowering what we owe by exactly the amount", async () => {
    const s = await h.seed.supplier("Mill One");
    await h.seed.purchase(s.id, { totalP: 900_000 });
    expect(await supplierBalanceSql(h.admin, s.id)).toBe(900_000);

    const res = await pay(s.id, 250_000, { method: "JazzCash", note: "advance" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      direction: "OUT", partyType: "SUPPLIER", partyId: s.id, partyName: "Mill One", isRefund: false, amountP: 250_000,
      method: "JazzCash", note: "advance", status: "POSTED", allocations: [], unallocatedP: 250_000,
    });
    expect(res.body.receiptNumber).toMatch(/^PV-2026-\d{6}$/);
    expect(await supplierBalanceSql(h.admin, s.id)).toBe(650_000);

    const [e] = await entriesFor(h.admin, "PAYMENT", res.body.id);
    expect(e!.lines).toEqual([
      { code: "CASH", party_type: null, party_id: null, debit: 0, credit: 250_000 },
      { code: "PAYABLES", party_type: "SUPPLIER", party_id: s.id, debit: 250_000, credit: 0 },
    ]);
    const audit = await h.admin`SELECT action FROM audit_log WHERE entity = 'Payment' AND entity_id = ${res.body.id}`;
    expect(audit.map((a) => a.action)).toEqual(["Payment made to supplier"]);
  });

  it("refuses an unknown supplier with the legacy wording, and writes nothing", async () => {
    const res = await pay("00000000-0000-4000-8000-000000000000", 1_000);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ message: "Choose a supplier.", errors: ["Choose a supplier."] });
  });

  it("optional purchase allocations: accepted up to the outstanding, purchases.status is NOT touched", async () => {
    const s = await h.seed.supplier();
    const p1 = await h.seed.purchase(s.id, { totalP: 400_000, number: "PUR-P-1", status: "RECEIVED" });
    const res = await pay(s.id, 500_000, { allocations: [{ purchaseId: p1.id, amountP: 400_000 }] });
    expect(res.status).toBe(201);
    expect(res.body.allocations.map((a: any) => [a.documentNumber, a.amountP])).toEqual([["PUR-P-1", 400_000]]);
    expect(res.body.unallocatedP).toBe(100_000);
    const [row] = await h.admin`SELECT status FROM purchases WHERE id = ${p1.id}`;
    expect(row!.status).toBe("RECEIVED"); // purchase payment state is M3's

    // that purchase is now fully paid: it drops off the outstanding list and cannot take another rupee
    const list = await h.request(owner, "GET", `/suppliers/${s.id}/outstanding-purchases`);
    expect(list.body).toEqual([]);
    const again = await pay(s.id, 1_000, { allocations: [{ purchaseId: p1.id, amountP: 1_000 }] });
    expect(again.body.errors).toEqual(["Purchase PUR-P-1: Rs 10.00 is more than the Rs 0.00 outstanding."]);
  });

  it("purchase allocation guards: over outstanding, other supplier's purchase, CANCELLED, duplicate, unknown, Σ > amount", async () => {
    const s = await h.seed.supplier();
    const other = await h.seed.supplier();
    const mine = await h.seed.purchase(s.id, { totalP: 300_000, number: "PUR-G-1" });
    const cancelled = await h.seed.purchase(s.id, { totalP: 300_000, number: "PUR-G-2", status: "CANCELLED" });
    const theirs = await h.seed.purchase(other.id, { totalP: 300_000, number: "PUR-G-3" });
    const errs = async (allocations: unknown[], amountP = 1_000_000) => (await pay(s.id, amountP, { allocations })).body.errors;

    expect(await errs([{ purchaseId: mine.id, amountP: 300_001 }])).toEqual(["Purchase PUR-G-1: Rs 3,000.01 is more than the Rs 3,000.00 outstanding."]);
    expect(await errs([{ purchaseId: theirs.id, amountP: 100 }])).toEqual(["Purchase PUR-G-3 does not belong to this supplier."]);
    expect(await errs([{ purchaseId: cancelled.id, amountP: 100 }])).toEqual(["Purchase PUR-G-2 is cancelled and cannot be paid."]);
    expect(await errs([{ purchaseId: "00000000-0000-4000-8000-000000000000", amountP: 100 }])).toEqual(["A purchase in the allocations does not exist."]);
    expect(await errs([{ purchaseId: mine.id, amountP: 100 }, { purchaseId: mine.id, amountP: 100 }])).toContain("The same purchase appears more than once in the allocations.");
    expect(await errs([{ purchaseId: mine.id, amountP: 200_000 }], 100_000)).toEqual(["The allocations total Rs 2,000.00, more than the Rs 1,000.00 paid."]);
  });

  it("a supplier's payment in the middle of a REVERSED voucher's allocations: reversed allocations no longer count as paid", async () => {
    const s = await h.seed.supplier();
    const p1 = await h.seed.purchase(s.id, { totalP: 300_000, number: "PUR-Z-1" });
    const first = await pay(s.id, 300_000, { allocations: [{ purchaseId: p1.id, amountP: 300_000 }] });
    await h.request(owner, "POST", `/payments/${first.body.id}/reverse`, { body: { reason: "wrong supplier" } });
    const list = await h.request(owner, "GET", `/suppliers/${s.id}/outstanding-purchases`);
    expect(list.body.map((r: any) => [r.number, r.paidP, r.outstandingP])).toEqual([["PUR-Z-1", 0, 300_000]]);
  });
});

describe("refund — money out to a shop", () => {
  it("writes an OUT / CUSTOMER voucher with isRefund = true, numbered PV-…, DR RECEIVABLES / CR CASH, raising what the shop owes", async () => {
    const c = await h.seed.customer("Refund Shop");
    await h.seed.invoice(c.id, { totalP: 300_000 });
    // a shop that overpaid is owed money; refunding it moves its balance back up
    expect(await customerBalanceSql(h.admin, c.id)).toBe(300_000);

    const res = await refund(c.id, 100_000, { reference: "Overpaid", note: "cash back" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      direction: "OUT", partyType: "CUSTOMER", partyId: c.id, partyName: "Refund Shop", isRefund: true, amountP: 100_000,
      status: "POSTED", allocations: [], reference: "Overpaid",
    });
    expect(res.body.receiptNumber).toMatch(/^PV-2026-\d{6}$/);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(400_000);

    const [e] = await entriesFor(h.admin, "PAYMENT", res.body.id);
    expect(e!.lines).toEqual([
      { code: "CASH", party_type: null, party_id: null, debit: 0, credit: 100_000 },
      { code: "RECEIVABLES", party_type: "CUSTOMER", party_id: c.id, debit: 100_000, credit: 0 },
    ]);
    const audit = await h.admin`SELECT action FROM audit_log WHERE entity_id = ${res.body.id}`;
    expect(audit.map((a) => a.action)).toEqual(["Refund paid to shop"]);
  });

  it("refuses an unknown shop; refund takes no allocations (an unknown field is rejected, not ignored)", async () => {
    const bad = await refund("00000000-0000-4000-8000-000000000000", 1_000);
    expect(bad.body).toEqual({ message: "Choose a shop.", errors: ["Choose a shop."] });
    const c = await h.seed.customer();
    const withAlloc = await refund(c.id, 1_000, { allocations: [] });
    expect(withAlloc.status).toBe(422);
    expect(withAlloc.body.message).toMatch(/Unrecognized key/);
  });

  it("PV numbers are shared between supplier payments and refunds (one series per kind)", async () => {
    const c = await h.seed.customer();
    const s = await h.seed.supplier();
    const a = await refund(c.id, 1_000);
    const b = await pay(s.id, 1_000);
    const n = (r: any) => Number(r.body.receiptNumber.split("-")[2]);
    expect(n(b)).toBe(n(a) + 1);
  });
});
