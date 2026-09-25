import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacyLedger, reconcile, runImport, uuidV5, type Backup, type ReconciliationReport } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { statementSchema } from "@farooq/shared";
import { createHarness, supplierBalanceSql, trialBalance, type Harness, type Session } from "./helpers/harness.js";
import { levelOf, movementSum } from "./helpers/invoices.js";
import { costsOf, postPur, purBody, purEditBody, purMovements, putPur, getPur } from "./helpers/purchases.js";

/**
 * THE PURCHASE LEDGER BRIDGE — S7's bridge for M3 (CLAUDE.md rule 8).
 *
 * 1. Import the synthetic fixture (every balance, every stock quantity and every average cost reconciles).
 * 2. Run a scripted sequence of purchase operations through the HTTP API: create with money paid and a part delivery, edit up / a part
 *    delivery completed / paid raised, an ORDER (received 0) and its part receipt, an edit of an IMPORTED purchase (with a landed-cost share on
 *    a line), an imported DRAFT received in full, a voucher reversed, an imported CANCELLED purchase refused.
 * 3. Apply THE SAME operations, by hand, to the fixture's legacy-shaped JSON, the way the legacy `Purchases.save` wrote them (a full
 *    reverse + re-receive on edit; the cost wrapper's figures) — with the ONE deliberate exception that a PART DELIVERY carries the FIXED goods
 *    unit (line value / ORDERED bags), not the legacy's overstated one (owner decision, fix 3).
 * 4. Compare, for EVERY supplier, the legacy ledger algorithm (`LegacyLedger`, no database) with the new journal; the stock levels with
 *    Σ movements and with hand-computed bags; the average costs with hand-computed figures; then run the real reconciliation on the result:
 *    purchase totals, purchase <-> stock, and every average cost recomputed from the lines must all still be 0 mismatches.
 *
 * Every expected figure below was derived on paper (paisa / thousandths) from the fixture header, not by running either side.
 *
 *  step  operation (today = 2026-03-05)                                                           supplier balance after (paisa)
 *   1    PUR-…05 sup-3: 20 bags p-1@wh-1 @600 (in) + 10 ordered p-3@wh-2 @500 (4 arrive), freight     sup-3 -40,000 + 1,730,000 - 200,000 = 1,490,000
 *        300, paid 2,000 (PV-…05)
 *   2    edit PUR-…05: 25 bags p-1, the rest of p-3 arrives (10), paid up to 4,000 (PV-…06 2,000)     sup-3 -40,000 + 2,030,000 - 400,000 = 1,590,000
 *   3    PUR-…06 sup-5: an ORDER 30 bags p-2@wh-1 @900, nothing received                              sup-5 2,700,000
 *   4    edit PUR-…06: 12 bags arrive (part delivery)                                                  sup-5 2,700,000
 *   5    edit PUR-…01 (imported, sup-1): line 1 12 -> 14 bags (its line 2 carries a 9,000 landed share)  sup-1 870,000 + 120,000 = 990,000
 *   6    edit PUR-…02 (imported DRAFT, sup-2): the 10 bags arrive                                      sup-2 390,000 (unchanged)
 *   7    edit PUR-…03 (imported CANCELLED): refused                                                    (nothing moves)
 *   8    reverse PV-…06                                                                                sup-3 1,590,000 + 200,000 = 1,790,000
 *  Final payables: s1 990,000  s2 390,000  s3 1,790,000  s4 92,000  s5 2,700,000   (Σ 5,962,000 = 1,312,000 + 4,650,000)
 *  Final bags: p-1@wh-1 90.5 + 25 + 2 = 117.5 (0.6 damaged untouched)  p-3@wh-2 60 + 10 = 70  p-2@wh-1 52 + 12 = 64  p-3@wh-1 38 + 10 = 48  p-2@wh-2 3  p-1@wh-2 32
 *
 *  Cost figures (LANDED basis, the legacy default; fix 3 for the part delivery). Charges are spread by line value, then per RECEIVED bag:
 *   step 1  L1 share round(30,000 x 1,200,000 / 1,700,000) = 21,176, landed 60,000 + round(21,176 / 20) = 61,059
 *           L2 share 8,824, goods unit 500,000 / 10 ORDERED = 50,000 (legacy: 125,000), landed 50,000 + round(8,824 / 4) = 52,206
 *           avg p-1@wh-1 = (12 x 64,286 [pur-1 L1] + 20 x 61,059) / 32 = 62,269.125 -> 62,269, last 61,059
 *           avg p-3@wh-2 = (60 x 1,667 [pur-4, as the backup stored it] + 4 x 52,206) / 64 = 4,825.69 -> 4,826, last 52,206
 *   step 2  L1 share 22,500, landed 60,000 + 900 = 60,900;  L2 share 7,500, landed 50,000 + 750 = 50,750
 *           avg p-1@wh-1 = (12 x 64,286 + 25 x 60,900) / 37 = 61,998.16 -> 61,998;  avg p-3@wh-2 = (60 x 1,667 + 10 x 50,750) / 70 = 8,678.86 -> 8,679
 *   step 3  nothing received anywhere for p-2@wh-1 (pur-3 is cancelled): the legacy fall-back gives avg = last = the bill's 90,000 (was 85,000)
 *   step 4  12 received: avg 90,000
 *   step 5  charges 60,000 over goods 960,000: L1 share 52,500, landed 60,000 + round(52,500 / 14) = 63,750 (+ operational 0);
 *           L2 share 7,500, landed 40,000 + round(7,500 / 3) + round(9,000 / 3) = 45,500 (the 9,000 landed share is CARRIED OVER)
 *           avg p-1@wh-1 = (14 x 63,750 + 25 x 60,900) / 39 = 61,923.08 -> 61,923, last 63,750;  avg p-2@wh-2 = 45,500
 *   step 6  line value 440,000 / 10 ordered = 44,000: avg = last = 44,000 (was 0)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "../../../packages/import/fixtures/synthetic-backup.json");

let h: Harness;
let owner: Session;
let backup: Backup;
const id = (store: string, legacyId: string) => uuidV5(`${store}:${legacyId}`);
const sup = (l: string) => id("suppliers", l);
const P1 = id("products", "p-1");
const P2 = id("products", "p-2");
const P3 = id("products", "p-3");
const WH1 = id("warehouses", "wh-1");
const WH2 = id("warehouses", "wh-2");

const made: Record<string, any> = {}; // step name -> the purchase as the API returned it (latest)

beforeAll(async () => {
  backup = JSON.parse(readFileSync(FIXTURE, "utf8"));
  await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "purchase-ledger-bridge" });
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const ok = (r: { status: number; body: any }, want = [200, 201]) => {
  expect(want, JSON.stringify(r.body)).toContain(r.status);
  return r.body;
};

describe("purchase ledger bridge: import the fixture, operate through the API, mirror by hand, compare", () => {
  it("0. before any operation the imported fixture already has the hand-computed payables, bags and average costs", async () => {
    const before = { "sup-1": 870_000, "sup-2": 390_000, "sup-3": -40_000, "sup-4": 92_000, "sup-5": 0 };
    for (const [l, p] of Object.entries(before)) expect(await supplierBalanceSql(h.admin, sup(l)), l).toBe(p);
    expect(await levelOf(h, P1, WH1)).toBe(90_500);
    expect(await levelOf(h, P3, WH2)).toBe(60_000);
    expect(await costsOf(h, P1, WH1)).toEqual({ avg: 64_286, last: 64_286 });
    expect(await costsOf(h, P3, WH2)).toEqual({ avg: 1_667, last: 1_667 });
    expect(await costsOf(h, P2, WH1)).toEqual({ avg: 85_000, last: 85_000 }); // kept from before: no purchase line received bags
  });

  it("1. the scripted operations through the API", async () => {
    const line = (productId: string, quantity: number, unitPriceP: number, extra: object = {}) => ({ productId, quantity, unitPriceP, ...extra });

    // 1: PUR-05 — two godowns, a part delivery (fix 3), freight, paid 2,000 in cash
    made.p5 = ok(await postPur(h, owner, purBody(sup("sup-3"), WH1, [line(P1, 20, 60_000), line(P3, 10, 50_000, { receivedQuantity: 4, warehouseId: WH2 })], { freightP: 30_000, paidAmountP: 200_000 })));
    expect(made.p5).toMatchObject({ number: "PUR-2026-000005", totalP: 1_730_000, status: "PARTIALLY_RECEIVED", paidP: 200_000, orderedQuantity: 30, receivedQuantity: 24 }); // the fixture's live counter (4) continues
    expect(made.p5.lines.map((l: any) => [l.goodsUnitCostP, l.chargeShareP, l.landedUnitCostP])).toEqual([[60_000, 21_176, 61_059], [50_000, 8_824, 52_206]]);
    expect(await supplierBalanceSql(h.admin, sup("sup-3"))).toBe(1_490_000);
    expect(await costsOf(h, P1, WH1)).toEqual({ avg: 62_269, last: 61_059 });
    expect(await costsOf(h, P3, WH2)).toEqual({ avg: 4_826, last: 52_206 });

    // 2: edit PUR-05 — more bags, the part delivery completes (received left blank), paid up to 4,000
    made.p5 = ok(
      await putPur(h, owner, made.p5.id, purEditBody(made.p5, { paidAmountP: 400_000 }, [
        { id: made.p5.lines[0].id, ...line(P1, 25, 60_000, { warehouseId: WH1 }) },
        { id: made.p5.lines[1].id, ...line(P3, 10, 50_000, { warehouseId: WH2 }) },
      ])),
    );
    expect(made.p5).toMatchObject({ totalP: 2_030_000, status: "RECEIVED", paidP: 400_000, revision: 2 });
    expect(made.p5.lines.map((l: any) => [l.goodsUnitCostP, l.chargeShareP, l.landedUnitCostP])).toEqual([[60_000, 22_500, 60_900], [50_000, 7_500, 50_750]]);
    expect(await supplierBalanceSql(h.admin, sup("sup-3"))).toBe(1_590_000);
    expect(await costsOf(h, P1, WH1)).toEqual({ avg: 61_998, last: 60_900 });
    expect(await costsOf(h, P3, WH2)).toEqual({ avg: 8_679, last: 50_750 });

    // 3 & 4: PUR-06 — an ORDER (nothing received), then a part receipt
    made.p6 = ok(await postPur(h, owner, purBody(sup("sup-5"), WH1, [line(P2, 30, 90_000, { receivedQuantity: 0 })])));
    expect(made.p6).toMatchObject({ number: "PUR-2026-000006", status: "ORDERED", totalP: 2_700_000, stockApplied: false });
    expect(await supplierBalanceSql(h.admin, sup("sup-5"))).toBe(2_700_000);
    expect(await levelOf(h, P2, WH1)).toBe(52_000);
    expect(await costsOf(h, P2, WH1)).toEqual({ avg: 90_000, last: 90_000 }); // the legacy fall-back (was 85,000)
    made.p6 = ok(await putPur(h, owner, made.p6.id, purEditBody(made.p6, {}, [{ id: made.p6.lines[0].id, ...line(P2, 30, 90_000, { receivedQuantity: 12, warehouseId: WH1 }) }])));
    expect(made.p6).toMatchObject({ status: "PARTIALLY_RECEIVED", receivedQuantity: 12 });
    expect(await levelOf(h, P2, WH1)).toBe(64_000);
    expect(await costsOf(h, P2, WH1)).toEqual({ avg: 90_000, last: 90_000 });

    // 5: PUR-01 (imported) — line 1 from 12 to 14 bags; its line 2 keeps the 9,000 landed-cost share
    const p1 = ok(await getPur(h, owner, id("purchases", "pur-1")));
    expect(p1.lines.map((l: any) => l.operationalShareP)).toEqual([0, 9_000]);
    made.p1 = ok(await putPur(h, owner, p1.id, purEditBody(p1, {}, [{ id: p1.lines[0].id, ...line(P1, 14, 60_000, { warehouseId: WH1 }) }, { id: p1.lines[1].id, ...line(P2, 3, 40_000, { warehouseId: WH2 }) }])));
    expect(made.p1).toMatchObject({ totalP: 1_020_000, status: "RECEIVED", paidP: 250_000, revision: 3 });
    expect(made.p1.lines.map((l: any) => [l.goodsUnitCostP, l.chargeShareP, l.landedUnitCostP, l.operationalShareP])).toEqual([[60_000, 52_500, 63_750, 0], [40_000, 7_500, 45_500, 9_000]]);
    expect(await costsOf(h, P1, WH1)).toEqual({ avg: 61_923, last: 63_750 });
    expect(await costsOf(h, P2, WH2)).toEqual({ avg: 45_500, last: 45_500 });

    // 6: PUR-02 (imported DRAFT with a line and an overall discount, nothing received): the 10 bags arrive
    const p2 = ok(await getPur(h, owner, id("purchases", "pur-2")));
    expect(p2).toMatchObject({ status: "DRAFT", itemDiscountsP: 60_000, invoiceDiscountP: 40_000, totalP: 400_000, receivedQuantity: 0 });
    made.p2 = ok(await putPur(h, owner, p2.id, purEditBody(p2, {}, [{ id: p2.lines[0].id, ...line(P3, 10, 50_000, { discountP: 60_000, warehouseId: WH1 }) }])));
    expect(made.p2).toMatchObject({ status: "RECEIVED", totalP: 400_000, revision: 2, stockApplied: true });
    expect(made.p2.lines[0]).toMatchObject({ goodsUnitCostP: 44_000, landedUnitCostP: 44_000 });
    expect(await costsOf(h, P3, WH1)).toEqual({ avg: 44_000, last: 44_000 });

    // 7: PUR-03 (imported CANCELLED): refused
    const p3 = ok(await getPur(h, owner, id("purchases", "pur-3")));
    const refused = await putPur(h, owner, p3.id, purEditBody(p3));
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual(["A cancelled purchase cannot be edited."]);

    // 8: the step-2 voucher (2,000) is reversed from Payments
    const extraVoucher = made.p5.payments.find((p: any) => p.allocatedP === 200_000 && p.receiptNumber !== made.p5.payments[0].receiptNumber);
    expect(extraVoucher.receiptNumber).toBe("PV-2026-000006");
    ok(await h.request(owner, "POST", `/payments/${extraVoucher.paymentId}/reverse`, { body: { reason: "wrong account" } }));
    made.p5 = ok(await getPur(h, owner, made.p5.id));
    expect(made.p5).toMatchObject({ paidP: 200_000, paymentStatus: "PARTIAL", balanceP: 1_830_000 });
  });

  it("2. hand-computed payables, bags and average costs straight from the database", async () => {
    const expected = { "sup-1": 990_000, "sup-2": 390_000, "sup-3": 1_790_000, "sup-4": 92_000, "sup-5": 2_700_000 };
    for (const [l, p] of Object.entries(expected)) expect(await supplierBalanceSql(h.admin, sup(l)), l).toBe(p);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(1_312_000 + 4_650_000);
    // bags: every level equals the hand-computed figure AND the sum of its movements
    const finals: [string, string, number][] = [[P1, WH1, 117_500], [P1, WH2, 32_000], [P2, WH1, 64_000], [P2, WH2, 3_000], [P3, WH1, 48_000], [P3, WH2, 70_000]];
    for (const [p, w, q] of finals) {
      expect(await levelOf(h, p, w)).toBe(q);
      expect(await movementSum(h, p, w)).toBe(q);
    }
    const [dmg] = await h.admin`SELECT qty_milli::int AS q FROM stock_levels WHERE product_id = ${P1} AND warehouse_id = ${WH1} AND bucket = 'damaged'`;
    expect(dmg!.q).toBe(600);
    // average costs: hand-computed in the header comment; the row no purchase line touches (p-1@wh-2) keeps what it had
    expect(await costsOf(h, P1, WH1)).toEqual({ avg: 61_923, last: 63_750 });
    expect(await costsOf(h, P2, WH2)).toEqual({ avg: 45_500, last: 45_500 });
    expect(await costsOf(h, P3, WH2)).toEqual({ avg: 8_679, last: 50_750 });
    expect(await costsOf(h, P2, WH1)).toEqual({ avg: 90_000, last: 90_000 });
    expect(await costsOf(h, P3, WH1)).toEqual({ avg: 44_000, last: 44_000 });
    expect(await costsOf(h, P1, WH2)).toEqual({ avg: 80_000, last: 0 });
  });

  it("3. sup-3's statement: its opening balance, the purchase and the paid voucher; the reversed voucher is left out (both entries)", async () => {
    const s = statementSchema.parse((await h.request(owner, "GET", `/suppliers/${sup("sup-3")}/statement`)).body);
    expect(s.closing).toBe(1_790_000);
    expect(s.rows.map((r) => r.ref).sort()).toEqual(["OPENING", "PUR-2026-000005", made.p5.payments[0].receiptNumber].sort());
    expect(s.omittedReversed).toBe(1);
  });

  describe("4. the same operations applied BY HAND to the legacy-shaped JSON", () => {
    let legacy: Backup;
    beforeAll(() => {
      legacy = JSON.parse(JSON.stringify(backup));
      const d = legacy.data as Record<string, any[]>;
      const T = "2026-03-05T06:00:00.000Z";
      const purTemplate = d.purchases!.find((p) => p.id === "pur-1")!;
      const itemTemplate = d.purchaseItems!.find((i) => i.purchaseId === "pur-1")!;
      const payTemplate = d.payments!.find((p) => p.id === "pay-4")!;
      const running = new Map<string, number>();
      for (const m of d.stockMovements!) running.set(`${m.productId}|${m.warehouseId}|${m.bucket}`, Math.round(m.balanceAfter * 1000));
      const purchase = (docId: string) => d.purchases!.find((p) => p.id === docId)!;

      /** A purchase document; its header worked out with plain integer arithmetic (never the shared Calc). */
      type L = { p: string; wh: string; qty: number; recv: number; unit: number; disc?: number; goods: number; share: number; landed: number; op?: number };
      const setPurchase = (docId: string, no: string, supplierId: string, status: string, lines: L[], charges: { freight?: number; loading?: number; inv?: number }, extra: object) => {
        const gross = lines.reduce((a, l) => a + l.qty * l.unit, 0);
        const itemDisc = lines.reduce((a, l) => a + (l.disc ?? 0), 0);
        const grand = gross - itemDisc - (charges.inv ?? 0) + (charges.freight ?? 0) + (charges.loading ?? 0);
        const doc = {
          ...purTemplate, id: docId, purchaseNumber: no, clientOpId: `op-${docId}`, supplierId, supplierNameSnapshot: "", warehouseId: "wh-1", purchaseDate: "2026-03-05", subtotal: gross,
          discountAmount: itemDisc + (charges.inv ?? 0), taxAmount: 0, freightAmount: charges.freight ?? 0, loadingAmount: charges.loading ?? 0, otherCharges: 0, grandTotal: grand,
          paidAmount: 0, balanceAmount: grand, paymentStatus: "UNPAID", status, totalQty: lines.reduce((a, l) => a + l.qty, 0), lineCount: lines.length, createdAt: T, updatedAt: T,
          stockApplied: lines.some((l) => l.recv > 0), orderedQty: lines.reduce((a, l) => a + l.qty, 0), receivedQty: lines.reduce((a, l) => a + l.recv, 0), revision: 1, ...extra,
        };
        const at = d.purchases!.findIndex((p) => p.id === docId);
        if (at >= 0) d.purchases![at] = doc;
        else d.purchases!.push(doc);
        d.purchaseItems = d.purchaseItems!.filter((x) => x.purchaseId !== docId);
        lines.forEach((l, i) =>
          d.purchaseItems!.push({
            ...itemTemplate, id: `pi-${docId}-${i + 1}`, purchaseId: docId, sortOrder: i, productId: l.p, warehouseId: l.wh, quantity: l.qty, orderedQty: l.qty, receivedQty: l.recv, unitPrice: l.unit,
            discount: l.disc ?? 0, tax: 0, lineTotal: l.qty * l.unit - (l.disc ?? 0), returnedQty: 0, goodsUnitCost: l.goods, chargeShare: l.share, landedUnitCost: l.landed,
            ...(l.op !== undefined ? { operationalShare: l.op } : { operationalShare: undefined }),
          }),
        );
      };
      const mv = (p: string, wh: string, kind: string, qty: number, refType: string, ref: string, unitCostP = 0) => {
        const key = `${p}|${wh}|stock`;
        const next = (running.get(key) ?? 0) + Math.round(qty * 1000);
        running.set(key, next);
        d.stockMovements!.push({ ...d.stockMovements![0], id: `mv-new-${d.stockMovements!.length}`, createdAt: T, date: "2026-03-05", productId: p, warehouseId: wh, kind, qtyDelta: qty, bucket: "stock", balanceAfter: next / 1000, ref, refType, note: "", unitCostP });
      };
      const voucher = (docId: string, no: string, supplierId: string, amount: number, purchaseDocId: string, extra: object = {}) => {
        d.payments!.push({ ...payTemplate, id: docId, receiptNumber: no, partyId: supplierId, amount, paymentDate: "2026-03-05", createdAt: T, status: "POSTED", method: "Cash", reference: "", note: "", ...extra });
        d.paymentAllocations!.push({ id: `al-${docId}`, paymentId: docId, invoiceId: null, purchaseId: purchaseDocId, amount, createdAt: T });
      };

      // 1 & 2: PUR-05, posted with 20 + 4-of-10 bags and 2,000 paid; edited to 25 + all 10 with 4,000 paid — the legacy reverses the old lines and receives the new ones.
      // The part delivery (L2) carries the FIXED goods unit 50,000 (line value / ORDERED bags); the legacy would have written 125,000 (500,000 / 4 received).
      setPurchase("n5", "PUR-2026-000005", "sup-3", "PARTIALLY_RECEIVED", [
        { p: "p-1", wh: "wh-1", qty: 20, recv: 20, unit: 60_000, goods: 60_000, share: 21_176, landed: 61_059 },
        { p: "p-3", wh: "wh-2", qty: 10, recv: 4, unit: 50_000, goods: 50_000, share: 8_824, landed: 52_206 },
      ], { freight: 30_000 }, {});
      mv("p-1", "wh-1", "PURCHASE_IN", 20, "PURCHASE", "PUR-2026-000005", 60_000);
      mv("p-3", "wh-2", "PURCHASE_IN", 4, "PURCHASE", "PUR-2026-000005", 50_000);
      voucher("v5", "PV-2026-000005", "sup-3", 200_000, "n5");
      setPurchase("n5", "PUR-2026-000005", "sup-3", "RECEIVED", [
        { p: "p-1", wh: "wh-1", qty: 25, recv: 25, unit: 60_000, goods: 60_000, share: 22_500, landed: 60_900 },
        { p: "p-3", wh: "wh-2", qty: 10, recv: 10, unit: 50_000, goods: 50_000, share: 7_500, landed: 50_750 },
      ], { freight: 30_000 }, { revision: 2, paidAmount: 400_000, balanceAmount: 1_630_000, paymentStatus: "PARTIAL" });
      mv("p-1", "wh-1", "PURCHASE_REVERSAL_OUT", -20, "PURCHASE_EDIT", "PUR-2026-000005");
      mv("p-3", "wh-2", "PURCHASE_REVERSAL_OUT", -4, "PURCHASE_EDIT", "PUR-2026-000005");
      mv("p-1", "wh-1", "PURCHASE_IN", 25, "PURCHASE", "PUR-2026-000005", 60_000);
      mv("p-3", "wh-2", "PURCHASE_IN", 10, "PURCHASE", "PUR-2026-000005", 50_000);
      voucher("v6", "PV-2026-000006", "sup-3", 200_000, "n5");
      // 3 & 4: PUR-06, an ORDER (received 0: no stock), then 12 of 30 arrive
      setPurchase("n6", "PUR-2026-000006", "sup-5", "PARTIALLY_RECEIVED", [{ p: "p-2", wh: "wh-1", qty: 30, recv: 12, unit: 90_000, goods: 90_000, share: 0, landed: 90_000 }], {}, { revision: 2 });
      mv("p-2", "wh-1", "PURCHASE_IN", 12, "PURCHASE", "PUR-2026-000006", 90_000);
      // 5: PUR-01 line 1 12 -> 14 bags; the edit reverses both old lines and receives both new ones. Line 2 keeps its 9,000 operational share (26-landed-cost.js folds it back in)
      setPurchase("pur-1", "PUR-2026-000001", "sup-1", "RECEIVED", [
        { p: "p-1", wh: "wh-1", qty: 14, recv: 14, unit: 60_000, goods: 60_000, share: 52_500, landed: 63_750, op: 0 },
        { p: "p-2", wh: "wh-2", qty: 3, recv: 3, unit: 40_000, goods: 40_000, share: 7_500, landed: 45_500, op: 9_000 },
      ], { freight: 40_000, loading: 20_000 }, { purchaseDate: "2026-02-20", createdAt: purTemplate.createdAt, updatedAt: T, revision: 3, warehouseId: "wh-1", paidAmount: 250_000, balanceAmount: 770_000, paymentStatus: "PARTIAL" });
      mv("p-1", "wh-1", "PURCHASE_REVERSAL_OUT", -12, "PURCHASE_EDIT", "PUR-2026-000001");
      mv("p-2", "wh-2", "PURCHASE_REVERSAL_OUT", -3, "PURCHASE_EDIT", "PUR-2026-000001");
      mv("p-1", "wh-1", "PURCHASE_IN", 14, "PURCHASE", "PUR-2026-000001", 60_000);
      mv("p-2", "wh-2", "PURCHASE_IN", 3, "PURCHASE", "PUR-2026-000001", 40_000);
      // 6: PUR-02 (DRAFT, line discount 60,000 + overall 40,000, nothing received): the legacy save makes it RECEIVED and receives the 10 bags. The date and supplier stay.
      setPurchase("pur-2", "PUR-2026-000002", "sup-2", "RECEIVED", [{ p: "p-3", wh: "wh-1", qty: 10, recv: 10, unit: 50_000, disc: 60_000, goods: 44_000, share: 0, landed: 44_000 }], { inv: 40_000 }, { purchaseDate: "2026-02-22", createdAt: purchase("pur-2").createdAt, revision: 2 });
      mv("p-3", "wh-1", "PURCHASE_IN", 10, "PURCHASE", "PUR-2026-000002", 50_000);
      // 8: the reversal of PV-06 (Payments.reverse: status REVERSED; the legacy also deleted the allocation and refreshed the purchase's paid figure)
      Object.assign(d.payments!.find((p) => p.id === "v6")!, { status: "REVERSED", reversedAt: T, reverseReason: "wrong account" });
      d.paymentAllocations = d.paymentAllocations!.filter((a) => a.paymentId !== "v6");
      Object.assign(purchase("n5"), { paidAmount: 200_000, balanceAmount: 1_830_000 });
      // the legacy inventory rows after all of it (bags and the cost wrapper's figures)
      const inventory = (p: string, wh: string) => d.inventory!.find((r) => r.productId === p && r.warehouseId === wh)!;
      Object.assign(inventory("p-1", "wh-1"), { qty: 117.5, avgCostP: 61_923, lastCostP: 63_750 });
      Object.assign(inventory("p-2", "wh-2"), { qty: 3, avgCostP: 45_500, lastCostP: 45_500 });
      Object.assign(inventory("p-3", "wh-2"), { qty: 70, avgCostP: 8_679, lastCostP: 50_750 });
      Object.assign(inventory("p-2", "wh-1"), { qty: 64, avgCostP: 90_000, lastCostP: 90_000 });
      Object.assign(inventory("p-3", "wh-1"), { qty: 48, avgCostP: 44_000, lastCostP: 44_000 });
      // the live counters
      d.sequences!.find((s) => JSON.stringify(s).includes('"PUR"'))!.n = 6;
      d.sequences!.find((s) => JSON.stringify(s).includes('"PV"'))!.n = 6;
      const counts = legacy.counts as Record<string, number>;
      for (const [store, docs] of Object.entries(d)) counts[store] = docs.length;
    });

    it("hand-computed expectations per supplier on the legacy algorithm (paper arithmetic — neither implementation involved)", () => {
      const ledger = createLegacyLedger(legacy.data);
      const expected = { "sup-1": 990_000, "sup-2": 390_000, "sup-3": 1_790_000, "sup-4": 92_000, "sup-5": 2_700_000 };
      for (const [l, p] of Object.entries(expected)) expect(ledger.supplier(l).closing, `legacy ${l}`).toBe(p);
    });

    it("EVERY party: the old algorithm's balance == the new journal's balance", async () => {
      const ledger = createLegacyLedger(legacy.data);
      expect(ledger.supplierIds).toHaveLength(5);
      for (const l of ledger.supplierIds) expect(await supplierBalanceSql(h.admin, sup(l)), `supplier ${l}`).toBe(ledger.supplier(l).closing);
      for (const l of ledger.customerIds) {
        const [row] = await h.admin`SELECT COALESCE(SUM(l.debit_p - l.credit_p), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = 'RECEIVABLES' AND l.party_id = ${id("customers", l)}`;
        expect(Number(row!.b), `customer ${l}`).toBe(ledger.customer(l).closing);
      }
    });

    it("the trial balance is still zero, every entry balances, and each purchase has exactly ONE PURCHASE entry (edited in place, never a second)", async () => {
      const t = await trialBalance(h.admin);
      expect(t.debit).toBe(t.credit);
      expect(await h.admin`SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_p) <> SUM(credit_p)`).toHaveLength(0);
      for (const [name, pu] of Object.entries(made)) {
        const rows = await h.admin`SELECT source_type FROM journal_entries WHERE source_id = ${pu.id} ORDER BY source_type`;
        expect(rows.map((r) => r.source_type), name).toEqual(["PURCHASE"]);
      }
      // the reversed voucher: its payment entry + its reversal entry, and the pair cancels
      const rev = await h.admin`SELECT source_type FROM journal_entries WHERE source_id = (SELECT id FROM payments WHERE receipt_number = 'PV-2026-000006') ORDER BY source_type`;
      expect(rev.map((r) => r.source_type)).toEqual(["PAYMENT", "PAYMENT_REVERSAL"]);
    });

    it("the REAL reconciliation, run on the post-S12 database against the hand-updated JSON: 0 differences in balances, statements, purchase totals, stock, purchase <-> stock and every average cost", async () => {
      const report: ReconciliationReport = await reconcile(legacy, TEST_ADMIN_URL);
      expect(report.customers).toEqual({ compared: 6, differences: [] });
      expect(report.suppliers).toEqual({ compared: 5, differences: [] });
      expect(report.statements.mismatches).toEqual([]);
      expect(report.trialBalance.balanced).toBe(true);
      // S6 / S8's checks are untouched by purchases
      expect(report.invoices.totalMismatches).toEqual([]);
      expect(report.stock.mismatches).toEqual([]);
      expect(report.invoiceStock.mismatches).toEqual([]);
      // S11's checks, on the LIVE tables: purchase totals recomputed from the lines, purchase <-> stock, and every average cost
      expect(report.purchases.totalMismatches).toEqual([]);
      expect(report.purchases.noLines).toEqual([]);
      expect(report.purchases.checked).toBe(5); // pur-1, pur-2 (now with its bags), pur-4, PUR-05, PUR-06 (pur-3 is cancelled)
      expect(report.purchases.lines).toBe(7);
      expect(report.purchaseStock.mismatches).toEqual([]);
      expect(report.purchaseStock.purchasesChecked).toBe(6);
      expect(report.averageCost.mismatches).toEqual([]);
      expect(report.averageCost.rows).toBe(5);
      expect(report.averageCost.matched).toBe(5);
      expect(report.averageCost.keptFromBefore).toEqual([{ product: "p-1", warehouse: "wh-2", avgCostP: 80_000 }]); // the one row no purchase line touches
      expect(report.averageCost.operationalShare.mismatches).toEqual([]); // the 9,000 landed share survived the edit of PUR-01
      expect(report.averageCost.operationalShare.orphanRows).toEqual([]);
      expect(report.averageCost.landedUnit.mismatches).toEqual([]);
      // The two deliberate differences from the legacy, both counted here: (1) an EDIT posts the NET difference per product x godown where the legacy
      // reversed every old line and received the new ones (legacy-way rows added above: 2 + 4 + 0 + 1 + 4 + 1 = 12; net rows in the database: 2 + 2 + 0 + 1 + 1 + 1 = 7);
      // (2) a reversed voucher KEEPS its allocation row (S3: never delete money history) where the legacy deleted it (the fixture's 5 allocations + PV-05's = 6 in the database).
      const fixtureMovements = (backup.data.stockMovements ?? []).length;
      expect(report.counts.filter((c) => c.class === "imported" && !c.match).map((c) => [c.store, c.backup, c.loaded]).sort()).toEqual([
        ["paymentAllocations", 5, 6],
        ["stockMovements", fixtureMovements + 12, fixtureMovements + 7],
      ]);
      expect(report.failures).toHaveLength(2);
      // fix 3 on purpose: the imported part delivery (pur-4) still carries the backup's overstated unit until it is next saved; the NEW part delivery does not
      const differs = report.averageCost.allocation.differs.map((x) => x.purchase);
      expect(differs).toContain("PUR-2026-000004");
      expect(differs).not.toContain("PUR-2026-000005");
    });

    it("the purchase movements the API wrote are the net ones (checked against the database, line by line)", async () => {
      // PUR-05: create 2 IN, the edit net p-1 +5 and p-3 +6
      const mv5 = await purMovements(h, made.p5.id);
      expect(mv5.map((m) => [m.kind, m.refType, m.q, m.cost]).sort()).toEqual(
        [["PURCHASE_IN", "PURCHASE", 20_000, 60_000], ["PURCHASE_IN", "PURCHASE", 4_000, 50_000], ["PURCHASE_IN", "PURCHASE_EDIT", 5_000, 60_000], ["PURCHASE_IN", "PURCHASE_EDIT", 6_000, 50_000]].sort(),
      );
      // PUR-01 (imported): only line 1 changed by bags, so ONE movement (+2); line 2's bags did not change
      const mv1 = (await purMovements(h, made.p1.id)).filter((m) => m.note === "Adjusted on purchase edit"); // (the fixture's own edit history is on the same purchase)
      expect(mv1).toEqual([expect.objectContaining({ kind: "PURCHASE_IN", q: 2_000, productId: P1, warehouseId: WH1, cost: 60_000 })]);
    });
  });
});
