import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, entriesFor, supplierBalanceSql, trialBalance, type Harness, type Session } from "./helpers/harness.js";
import { levelOf, movementSum, seedWarehouse } from "./helpers/invoices.js";
import { costsOf, getPur, mkPurchase, purAudit, purEditBody, purMovements, purScenario, putPur, vouchersFor, type PurScenario } from "./helpers/purchases.js";

/**
 * Editing a recorded purchase — the legacy `test-purchase-edit.mjs` cases A-E and L, ported and re-worked by hand in paisa (Rs 1 = 100).
 * Every figure below was derived on paper from the legacy rules; the stock movements are the NET difference per product x godown
 * (planner decision 2: the legacy reversed every old line and re-received the new ones; the levels and the purchase <-> stock check agree).
 */
let h: Harness;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const ok = (r: { status: number; body: any }) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const refused = (r: { status: number; body: any }) => {
  expect(r.status, JSON.stringify(r.body)).toBe(422);
  return r.body.errors as string[];
};

/* ══════════ A. a clean round trip; B. changing what was entered; C. money; D. lines ══════════ */
describe("A-D: one purchase, edited in turn (the legacy A0 purchase)", () => {
  let s: PurScenario;
  let wh2: { id: string; name: string };
  let a0: any;
  let pu: any; // the latest state of the purchase, as the API returned it
  let pA: PurScenario["ps"][number], pB: PurScenario["ps"][number], pC: PurScenario["ps"][number];
  let owedBefore: number;

  beforeAll(async () => {
    s = await purScenario(h, 3);
    [pA, pB, pC] = s.ps as [PurScenario["ps"][number], PurScenario["ps"][number], PurScenario["ps"][number]];
    wh2 = await seedWarehouse(h);
    a0 = await mkPurchase(
      h,
      owner,
      s,
      [
        { productId: pA.id, quantity: 100, unitPriceP: 200_000, discountP: 30_000 },
        { productId: pB.id, quantity: 50, unitPriceP: 300_000, warehouseId: wh2.id },
      ],
      { date: "2026-03-01", supplierInvoiceNo: "MILL-1", vehicleNo: "lea-11", driver: "Aslam", deliveryRef: "D-9", notes: "first load", description: "Wheat flour, two grades", freightP: 150_000, loadingP: 50_000, invoiceDiscountP: 70_000, paidAmountP: 2_000_000, paymentMethod: "Bank Transfer" },
    );
    pu = a0;
    owedBefore = await supplierBalanceSql(h.admin, s.supplier.id);
  });

  it("A1-A3 the detail gives back what was entered, so an edit form can start from it (overall discount, charges, paid, line ids, blank received)", () => {
    expect(a0).toMatchObject({ invoiceDiscountP: 70_000, itemDiscountsP: 30_000, freightP: 150_000, loadingP: 50_000, paidP: 2_000_000, supplierInvoiceNo: "MILL-1", vehicleNo: "LEA-11", description: "Wheat flour, two grades", revision: 1 });
    expect(a0.lines.map((l: any) => [l.quantity, l.receivedQuantity, l.unitPriceP, l.discountP])).toEqual([[100, 100, 200_000, 30_000], [50, 50, 300_000, 0]]);
    expect(owedBefore).toBe(33_100_000);
  });

  it("A4-A10 saving it unchanged: same number, total, paid, status; stock and the supplier's balance exactly as before; no second payment; lines keep their ids; nothing else moves", async () => {
    const ids = a0.lines.map((l: any) => l.id);
    const auditBefore = (await purAudit(h, a0.id)).length;
    const r = ok(await putPur(h, owner, a0.id, purEditBody(a0)));
    expect(r).toMatchObject({ number: a0.number, totalP: 35_100_000, paidP: 2_000_000, status: "RECEIVED", revision: 2, createdBy: owner.userId, createdAt: a0.createdAt, description: "Wheat flour, two grades", notes: "first load" });
    expect(r.lines.map((l: any) => l.id)).toEqual(ids); // A7: every line kept its id
    expect(await levelOf(h, pA.id, s.wh.id)).toBe(100_000);
    expect(await levelOf(h, pB.id, wh2.id)).toBe(50_000);
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(owedBefore);
    expect(await vouchersFor(h, a0.id)).toHaveLength(1); // A6: the supplier was not paid twice
    // NET stock: nothing changed, so nothing was posted (the legacy wrote 2 reversals + 4 receipts that netted to zero)
    expect(await purMovements(h, a0.id)).toHaveLength(2);
    const audit = await purAudit(h, a0.id);
    expect(audit).toHaveLength(auditBefore + 1);
    expect(audit[audit.length - 1]).toMatchObject({ action: "Purchase edited", actor_id: owner.userId });
    expect(audit[audit.length - 1]!.before).toMatchObject({ grandTotal: 35_100_000, lineCount: 2, received: 150 });
    expect(audit[audit.length - 1]!.after).toMatchObject({ ref: a0.number, grandTotal: 35_100_000, lineCount: 2, received: 150 });
    pu = r;
  });

  it("B1-B6 more bags, dearer, higher freight, a corrected date: the total, the 20 extra bags, the supplier's account, the ledger row and the average all follow", async () => {
    const r = ok(
      await putPur(
        h,
        owner,
        a0.id,
        purEditBody(pu, { freightP: 250_000, date: "2026-03-02", notes: "corrected", vehicleNo: "lea-22" }, [
          { id: pu.lines[0].id, productId: pA.id, quantity: 120, unitPriceP: 210_000, discountP: 30_000, warehouseId: s.wh.id },
          { id: pu.lines[1].id, productId: pB.id, quantity: 50, unitPriceP: 300_000, warehouseId: wh2.id },
        ]),
      ),
    );
    // gross 25,200,000 + 15,000,000; line discount 30,000; overall 70,000; freight 250,000; loading 50,000 -> 40,400,000 (legacy: Rs 404,000)
    expect(r).toMatchObject({ subtotalP: 40_200_000, freightP: 250_000, discountAmountP: 100_000, totalP: 40_400_000, date: "2026-03-02", notes: "corrected", vehicleNo: "LEA-22", paidP: 2_000_000, revision: 3 });
    expect(await levelOf(h, pA.id, s.wh.id)).toBe(120_000); // B2: the 20 extra bags are in; the other line is unchanged
    expect(await levelOf(h, pB.id, wh2.id)).toBe(50_000);
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(owedBefore + (40_400_000 - 35_100_000)); // B3
    // the one journal entry carries the new date and amount (B5)
    const entries = await entriesFor(h.admin, "PURCHASE", a0.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ date: "2026-03-02", memo: `Purchase ${a0.number}` });
    expect(entries[0]!.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([["PAYABLES", 0, 40_400_000], ["PURCHASES", 40_400_000, 0]]);
    // the stock: exactly one NET movement (+20 bags of A), dated the date as saved, priced at the new unit price
    const mv = await purMovements(h, a0.id);
    expect(mv).toHaveLength(3);
    expect(mv[2]).toEqual({ kind: "PURCHASE_IN", refType: "PURCHASE_EDIT", ref: a0.number, date: "2026-03-02", q: 20_000, cost: 210_000, productId: pA.id, warehouseId: s.wh.id, note: "Adjusted on purchase edit" });
    // B6 charges 300,000 over goods 40,170,000: L1 share 187,976, goods unit 25,170,000 / 120 = 209,750, landed 209,750 + round(1,566.47) = 211,316; L2 share 112,024, landed 300,000 + round(2,240.48) = 302,240
    expect(r.lines[0]).toMatchObject({ goodsUnitCostP: 209_750, chargeShareP: 187_976, landedUnitCostP: 211_316 });
    expect(r.lines[1]).toMatchObject({ goodsUnitCostP: 300_000, chargeShareP: 112_024, landedUnitCostP: 302_240 });
    expect(await costsOf(h, pA.id, s.wh.id)).toEqual({ avg: 211_316, last: 211_316 });
    expect(await costsOf(h, pB.id, wh2.id)).toEqual({ avg: 302_240, last: 302_240 });
    expect(await movementSum(h, pA.id, s.wh.id)).toBe(120_000);
    pu = r;
  });

  it("C1-C2 lowering what was paid is refused (naming the voucher to reverse); paying more than the bill is refused", async () => {
    const v = await vouchersFor(h, a0.id);
    const c1 = refused(await putPur(h, owner, a0.id, purEditBody(pu, { paidAmountP: 500_000 })));
    expect(c1).toHaveLength(1);
    expect(c1[0]).toBe(`Rs 20,000.00 has already been paid against this purchase (${v[0]!.number}). The amount paid cannot be lowered here — reverse that payment voucher from Payments instead.`);
    const c2 = refused(await putPur(h, owner, a0.id, purEditBody(pu, { paidAmountP: 99_999_999 })));
    expect(c2).toEqual(["The amount paid is more than the purchase total. Record the extra as a separate payment to the supplier."]);
  });

  it("C3-C6 raising it to 35,000 adds ONE voucher for the 15,000 difference; saving again writes no further voucher; paying in full makes it PAID", async () => {
    const r = ok(await putPur(h, owner, a0.id, purEditBody(pu, { paidAmountP: 3_500_000, paymentMethod: "Cash", supplierInvoiceNo: "MILL-1" })));
    const v = await vouchersFor(h, a0.id);
    expect(v).toHaveLength(2);
    expect(v[1]).toMatchObject({ amount: 1_500_000, method: "Cash", reference: "MILL-1", note: `Paid with purchase ${a0.number}`, allocated: 1_500_000, date: "2026-03-02" });
    expect(v[0]).toMatchObject({ amount: 2_000_000, method: "Bank Transfer" });
    expect(r).toMatchObject({ paidP: 3_500_000, paymentStatus: "PARTIAL" });
    const owed = await supplierBalanceSql(h.admin, s.supplier.id);
    expect(owed).toBe(40_400_000 - 3_500_000);
    // C5: saving again (paid defaults to what was already paid) writes no further voucher and moves no balance
    const again = ok(await putPur(h, owner, a0.id, purEditBody(r)));
    expect(await vouchersFor(h, a0.id)).toHaveLength(2);
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(owed);
    // C6: paying it off in full
    const full = ok(await putPur(h, owner, a0.id, purEditBody(again, { paidAmountP: again.totalP })));
    expect(full).toMatchObject({ paidP: 40_400_000, paymentStatus: "PAID", balanceP: 0 });
    pu = full;
  });

  it("C7-C8 a voucher reversed from Payments lowers what the purchase says is paid (derived from the vouchers, nothing stored); the edit form then shows the truth", async () => {
    const last = pu.payments[pu.payments.length - 1];
    expect(last.allocatedP).toBe(40_400_000 - 3_500_000);
    const rev = await h.request(owner, "POST", `/payments/${last.paymentId}/reverse`, { body: { reason: "test" } });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const d = (await getPur(h, owner, a0.id)).body;
    expect(d).toMatchObject({ paidP: 3_500_000, paymentStatus: "PARTIAL", balanceP: 36_900_000 });
    expect(d.payments.map((p: any) => p.status)).toEqual(["POSTED", "POSTED", "REVERSED"]);
    // an edit that changes nothing else keeps it; the default for "paid" is what is REALLY paid
    const saved = ok(await putPur(h, owner, a0.id, purEditBody(d)));
    expect(saved.paidP).toBe(3_500_000);
    expect(await vouchersFor(h, a0.id)).toHaveLength(3);
    pu = saved;
  });

  it("D1-D4 drop a line and add another: the dropped line is deleted and its bags leave the godown; the kept line keeps its id; the new line gets one; the header follows", async () => {
    const keptId = pu.lines[0].id;
    const droppedId = pu.lines[1].id;
    const r = ok(
      await putPur(h, owner, a0.id, purEditBody(pu, {}, [
        { id: keptId, productId: pA.id, quantity: 120, unitPriceP: 210_000, discountP: 30_000, warehouseId: s.wh.id },
        { productId: pC.id, quantity: 10, unitPriceP: 400_000 },
      ])),
    );
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].id).toBe(keptId);
    expect(r.lines[1].id).not.toBe(droppedId);
    expect(r.lines[1]).toMatchObject({ productId: pC.id, warehouseId: s.wh.id, quantity: 10 });
    expect((await h.admin`SELECT 1 FROM purchase_items WHERE id = ${droppedId}`).length).toBe(0); // D3: really deleted
    expect(r).toMatchObject({ lineCount: 2, orderedQuantity: 130, receivedQuantity: 130 });
    expect(await levelOf(h, pB.id, wh2.id)).toBe(0); // B's 50 bags left the godown ...
    expect(await levelOf(h, pC.id, s.wh.id)).toBe(10_000); // ... and C's 10 arrived
    const mv = await purMovements(h, a0.id);
    expect(mv.slice(-2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "PURCHASE_REVERSAL_OUT", refType: "PURCHASE_EDIT", q: -50_000, cost: null, productId: pB.id, warehouseId: wh2.id }),
        expect.objectContaining({ kind: "PURCHASE_IN", refType: "PURCHASE_EDIT", q: 10_000, cost: 400_000, productId: pC.id }),
      ]),
    );
    expect(await movementSum(h, pB.id, wh2.id)).toBe(0);
    // B's average: nothing is left of it anywhere, so the row keeps what it had (legacy: "if nothing is left, the old average is kept")
    expect(await costsOf(h, pB.id, wh2.id)).toEqual({ avg: 302_240, last: 302_240 });
    const t = await trialBalance(h.admin);
    expect(t.debit).toBe(t.credit);
  });
});

/* ══════════ D5. the average of a product taken off a purchase drops back to what is left ══════════ */
describe("D5 the average cost stops counting a purchase that no longer contains the product", () => {
  it("(100 @ 1,000 + 100 @ 3,000) / 200 = 2,000; take the product off the second purchase -> back to 1,000; the last cost is not touched", async () => {
    const s = await purScenario(h, 2);
    const [pD, pX] = s.ps as [PurScenario["ps"][number], PurScenario["ps"][number]];
    await mkPurchase(h, owner, s, [{ productId: pD.id, quantity: 100, unitPriceP: 100_000 }]);
    const second = await mkPurchase(h, owner, s, [{ productId: pD.id, quantity: 100, unitPriceP: 300_000 }]);
    expect(await costsOf(h, pD.id, s.wh.id)).toEqual({ avg: 200_000, last: 300_000 });
    ok(await putPur(h, owner, second.id, purEditBody(second, {}, [{ productId: pX.id, quantity: 5, unitPriceP: 400_000 }])));
    expect(await costsOf(h, pD.id, s.wh.id)).toEqual({ avg: 100_000, last: 300_000 });
    expect(await levelOf(h, pD.id, s.wh.id)).toBe(100_000);
    expect(await costsOf(h, pX.id, s.wh.id)).toEqual({ avg: 400_000, last: 400_000 });
  });

  it("the ONLY purchase of a product loses it: the average is kept (nothing is left to average), the bags go", async () => {
    const s = await purScenario(h, 2);
    const [pD, pX] = s.ps as [PurScenario["ps"][number], PurScenario["ps"][number]];
    const only = await mkPurchase(h, owner, s, [{ productId: pD.id, quantity: 10, unitPriceP: 150_000 }]);
    ok(await putPur(h, owner, only.id, purEditBody(only, {}, [{ productId: pX.id, quantity: 1, unitPriceP: 100_000 }])));
    expect(await costsOf(h, pD.id, s.wh.id)).toEqual({ avg: 150_000, last: 150_000 });
    expect(await levelOf(h, pD.id, s.wh.id)).toBe(0);
  });

  it("an edit never nudges: two edits of the same purchase leave the average where a fresh recomputation puts it", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, unitPriceP: 100_000 }]);
    const second = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, unitPriceP: 300_000 }]);
    const e1 = ok(await putPur(h, owner, second.id, purEditBody(second, {}, [{ id: second.lines[0].id, productId: p.id, quantity: 100, unitPriceP: 500_000 }])));
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 300_000, last: 500_000 }); // (100 x 1,000 + 100 x 5,000) / 200
    ok(await putPur(h, owner, second.id, purEditBody(e1, {}, [{ id: e1.lines[0].id, productId: p.id, quantity: 100, unitPriceP: 500_000 }])));
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 300_000, last: 500_000 }); // the same: recomputed, not nudged twice
  });
});

/* ══════════ E. part deliveries ══════════ */
describe("E part deliveries", () => {
  it("E1-E4 editing only the rate keeps 60 of 100 in; the rest arriving brings 40 in; correcting the ordered quantity on a full load brings the extra bags in", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const e0 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, receivedQuantity: 60, unitPriceP: 100_000 }]);
    expect(e0.lines[0]).toMatchObject({ quantity: 100, receivedQuantity: 60 }); // E1: the form opens with the received figure spelled out
    expect(await levelOf(h, p.id, s.wh.id)).toBe(60_000);

    // E2: only the rate changes; the part delivery stays a part delivery (received sent back as 60)
    const e2 = ok(await putPur(h, owner, e0.id, purEditBody(e0, {}, [{ id: e0.lines[0].id, productId: p.id, quantity: 100, receivedQuantity: 60, unitPriceP: 120_000 }])));
    expect(e2).toMatchObject({ status: "PARTIALLY_RECEIVED", receivedQuantity: 60, totalP: 12_000_000 });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(60_000);
    expect(await purMovements(h, e0.id)).toHaveLength(1); // nothing new: the same 60 bags
    expect(e2.lines[0]).toMatchObject({ goodsUnitCostP: 120_000 }); // fix 3: line value 12,000,000 / ORDERED 100 (the legacy said 200,000)

    // E3: the rest arrives (received left blank = the whole line)
    const e3 = ok(await putPur(h, owner, e0.id, purEditBody(e2, {}, [{ id: e2.lines[0].id, productId: p.id, quantity: 100, unitPriceP: 120_000 }])));
    expect(e3).toMatchObject({ status: "RECEIVED", receivedQuantity: 100 });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(100_000);
    expect((await purMovements(h, e0.id))[1]).toMatchObject({ kind: "PURCHASE_IN", refType: "PURCHASE_EDIT", q: 40_000, cost: 120_000 });

    // E4: the ordered quantity is corrected to 110 on a fully received load -> the extra 10 come in
    const e4 = ok(await putPur(h, owner, e0.id, purEditBody(e3, {}, [{ id: e3.lines[0].id, productId: p.id, quantity: 110, unitPriceP: 120_000 }])));
    expect(e4).toMatchObject({ status: "RECEIVED", receivedQuantity: 110 });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(110_000);
  });

  it("an order (received 0) that is later received in full: +100 bags, the average becomes the line's real average", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const o = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, receivedQuantity: 0, unitPriceP: 100_000 }]);
    expect(o.status).toBe("ORDERED");
    const r = ok(await putPur(h, owner, o.id, purEditBody(o, {}, [{ id: o.lines[0].id, productId: p.id, quantity: 100, unitPriceP: 100_000 }])));
    expect(r).toMatchObject({ status: "RECEIVED", stockApplied: true });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(100_000);
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 100_000, last: 100_000 });
  });
});

/* ══════════ L. found on a second pass ══════════ */
describe("L dates and the warehouse", () => {
  it("L4 a date-only correction posts no stock (the bags did not change) and moves the ONE journal entry to the corrected date", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const l4 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }], { date: "2026-03-01" });
    ok(await putPur(h, owner, l4.id, purEditBody(l4, { date: "2026-03-04" })));
    expect(await purMovements(h, l4.id)).toHaveLength(1);
    expect((await entriesFor(h.admin, "PURCHASE", l4.id)).map((e) => e.date)).toEqual(["2026-03-04"]);
  });

  it("L4b date AND quantity corrected: the net movement is dated the date as saved", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const l = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }], { date: "2026-03-01" });
    ok(await putPur(h, owner, l.id, purEditBody(l, { date: "2026-03-04" }, [{ id: l.lines[0].id, productId: p.id, quantity: 13, unitPriceP: 100_000 }])));
    expect((await purMovements(h, l.id))[1]).toMatchObject({ kind: "PURCHASE_IN", date: "2026-03-04", q: 3_000, refType: "PURCHASE_EDIT" });
  });

  it("J4 moving the purchase to another warehouse takes the bags out of one and into the other (two net movements)", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const wh2 = await seedWarehouse(h);
    const j0 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 12, unitPriceP: 100_000 }]);
    const r = ok(await putPur(h, owner, j0.id, purEditBody(j0, { warehouseId: wh2.id }, [{ id: j0.lines[0].id, productId: p.id, quantity: 12, unitPriceP: 100_000, warehouseId: wh2.id }])));
    expect(r).toMatchObject({ warehouseId: wh2.id, warehouseName: wh2.name });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(0);
    expect(await levelOf(h, p.id, wh2.id)).toBe(12_000);
    // the average follows the bags: the old godown keeps its figure (nothing left to average), the new one gets the line's
    expect(await costsOf(h, p.id, wh2.id)).toEqual({ avg: 100_000, last: 100_000 });
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 100_000, last: 100_000 });
  });
});
