import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, entriesFor, supplierBalanceSql, trialBalance, type Harness, type Session } from "./helpers/harness.js";
import { levelOf, movementSum, seedProduct, seedStock, seedWarehouse } from "./helpers/invoices.js";
import { costsOf, mkPurchase, newKey, postPur, purAudit, purBody, purMovements, purScenario, vouchersFor } from "./helpers/purchases.js";
import { withCostBasis } from "./helpers/cost-basis.js";

/**
 * Recording a purchase — every expectation is worked out by hand from the legacy rules (`Purchases.save`, `Cost.allocate`,
 * `Landed.weightedAverage`, `Inventory.apply`), never read back from the code under test. Amounts are paisa; 1 bag = 1000 milli.
 * The company setting profitCostBasis is the real one, LANDED, unless a test says otherwise.
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

describe("create — one transaction writes number, header, lines, stock, average cost, journal, voucher and audit", () => {
  it("hand-computed: two lines in two godowns, a line and an overall discount, freight + loading, part paid by bank", async () => {
    const s = await purScenario(h, 2);
    const [A, B] = s.ps as [typeof s.ps[number], typeof s.ps[number]];
    const wh2 = await seedWarehouse(h);
    const r = await postPur(
      h,
      owner,
      purBody(
        s.supplier.id,
        s.wh.id,
        [
          { productId: A.id, quantity: 100, unitPriceP: 200_000, discountP: 30_000 },
          { productId: B.id, quantity: 50, unitPriceP: 300_000, warehouseId: wh2.id },
        ],
        { invoiceDiscountP: 70_000, freightP: 150_000, loadingP: 50_000, paidAmountP: 2_000_000, paymentMethod: "Bank Transfer", supplierInvoiceNo: "MILL-1", vehicleNo: "lea-11", driver: "Aslam", deliveryRef: "D-9", notes: "first load" },
      ),
    );
    expect(r.status).toBe(201);
    const b = r.body;
    expect(b.number).toMatch(/^PUR-2026-\d{6}$/);
    // header: subtotal 20,000,000 + 15,000,000; line discount 30,000; overall discount min(70,000, 34,970,000); no tax;
    // grand = 35,000,000 − 30,000 − 70,000 + 150,000 + 50,000 = 35,100,000
    expect(b).toMatchObject({
      status: "RECEIVED", paymentStatus: "PARTIAL", date: "2026-03-05", supplierId: s.supplier.id, supplierName: s.supplier.companyName, supplierInvoiceNo: "MILL-1",
      warehouseId: s.wh.id, vehicleNo: "LEA-11", driver: "Aslam", deliveryRef: "D-9", notes: "first load",
      subtotalP: 35_000_000, itemDiscountsP: 30_000, invoiceDiscountP: 70_000, discountAmountP: 100_000, taxP: 0, freightP: 150_000, loadingP: 50_000, otherChargesP: 0,
      totalP: 35_100_000, paidP: 2_000_000, balanceP: 33_100_000, orderedQuantity: 150, receivedQuantity: 150, lineCount: 2, stockApplied: true, migrated: false, revision: 1, createdBy: owner.userId,
    });
    expect(b.lines).toHaveLength(2);
    expect(b.lines[0]).toMatchObject({
      productId: A.id, warehouseId: s.wh.id, quantity: 100, qtyMilli: 100_000, receivedQuantity: 100, receivedQtyMilli: 100_000, returnedQuantity: 0, unitPriceP: 200_000, discountP: 30_000, taxP: 0, lineTotalP: 19_970_000,
      // charges 200,000 over goods 34,970,000: L1 share round(114,212.18) = 114,212; goods unit 19,970,000 / 100 = 199,700; landed 199,700 + round(1,142.12) = 200,842
      goodsUnitCostP: 199_700, chargeShareP: 114_212, landedUnitCostP: 200_842, operationalShareP: null, unit: "Bag", package: "50 KG", sortOrder: 0,
    });
    expect(b.lines[1]).toMatchObject({
      productId: B.id, warehouseId: wh2.id, quantity: 50, unitPriceP: 300_000, lineTotalP: 15_000_000,
      // L2 share round(85,787.82) = 85,788; goods unit 300,000; landed 300,000 + round(1,715.76) = 301,716
      goodsUnitCostP: 300_000, chargeShareP: 85_788, landedUnitCostP: 301_716, sortOrder: 1,
    });

    // stock: one PURCHASE_IN per product x godown, the received-weighted unit PRICE as its cost (200,000 / 300,000), dated the purchase date
    expect(await levelOf(h, A.id, s.wh.id)).toBe(100_000);
    expect(await levelOf(h, B.id, wh2.id)).toBe(50_000);
    expect(await movementSum(h, A.id, s.wh.id)).toBe(100_000);
    const mv = await purMovements(h, b.id);
    expect(mv).toEqual(
      expect.arrayContaining([
        { kind: "PURCHASE_IN", refType: "PURCHASE", ref: b.number, date: "2026-03-05", q: 100_000, cost: 200_000, productId: A.id, warehouseId: s.wh.id, note: s.supplier.companyName },
        { kind: "PURCHASE_IN", refType: "PURCHASE", ref: b.number, date: "2026-03-05", q: 50_000, cost: 300_000, productId: B.id, warehouseId: wh2.id, note: s.supplier.companyName },
      ]),
    );
    expect(mv).toHaveLength(2);
    // average cost (LANDED): the landed unit of the only line; last cost the same
    expect(await costsOf(h, A.id, s.wh.id)).toEqual({ avg: 200_842, last: 200_842 });
    expect(await costsOf(h, B.id, wh2.id)).toEqual({ avg: 301_716, last: 301_716 });

    // journal: exactly one PURCHASE entry, DR PURCHASES / CR PAYABLES(supplier) for the grand total, dated the purchase date
    const entries = await entriesFor(h.admin, "PURCHASE", b.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ date: "2026-03-05", memo: `Purchase ${b.number}`, created_by: owner.userId });
    expect(entries[0]!.lines).toEqual([
      { code: "PAYABLES", party_type: "SUPPLIER", party_id: s.supplier.id, debit: 0, credit: 35_100_000 },
      { code: "PURCHASES", party_type: null, party_id: null, debit: 35_100_000, credit: 0 },
    ]);
    // we owe 35,100,000 − 2,000,000 paid
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(33_100_000);

    // the voucher: one PV, the bank, the supplier's bill number as its reference, one allocation to this purchase
    const v = await vouchersFor(h, b.id);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ amount: 2_000_000, method: "Bank Transfer", reference: "MILL-1", note: `Paid with purchase ${b.number}`, date: "2026-03-05", status: "POSTED", allocated: 2_000_000 });
    expect(v[0]!.number).toMatch(/^PV-2026-\d{6}$/);
    expect(b.payments).toHaveLength(1);
    expect(b.payments[0]).toMatchObject({ receiptNumber: v[0]!.number, allocatedP: 2_000_000, status: "POSTED" });

    // audit: "Purchase recorded", by the user, with the figures
    const audit = await purAudit(h, b.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "Purchase recorded", actor_id: owner.userId, before: null });
    expect(audit[0]!.after).toMatchObject({ ref: b.number, grandTotal: 35_100_000, lineCount: 2, supplier: s.supplier.companyName, received: 150 });

    const t = await trialBalance(h.admin);
    expect(t.debit).toBe(t.credit);
  });

  it("numbers are gap-free and consecutive: PUR-<business year>-<6>", async () => {
    const s = await purScenario(h, 1);
    const line = { productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 };
    const a = await mkPurchase(h, owner, s, [line]);
    const b = await mkPurchase(h, owner, s, [line]);
    expect(Number(b.number.slice(-6))).toBe(Number(a.number.slice(-6)) + 1);
    expect(b.number.startsWith("PUR-2026-")).toBe(true);
  });

  it("the date can be in the past: the stock movement, the journal entry and the voucher all carry it", async () => {
    const s = await purScenario(h, 1);
    const b = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 2, unitPriceP: 100_000 }], { date: "2026-02-10", paidAmountP: 50_000 });
    expect(b.date).toBe("2026-02-10");
    expect((await purMovements(h, b.id))[0]!.date).toBe("2026-02-10");
    expect((await entriesFor(h.admin, "PURCHASE", b.id))[0]!.date).toBe("2026-02-10");
    expect((await vouchersFor(h, b.id))[0]!.date).toBe("2026-02-10");
  });

  it("line tax and both kinds of discount: 10 bags @ 1,000 - 100 line discount + 5% tax, overall discount 200 (hand-computed)", async () => {
    const s = await purScenario(h, 1);
    const b = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 10, unitPriceP: 100_000, discountP: 10_000, taxRatePct: 5 }], { invoiceDiscountP: 20_000 });
    // gross 1,000,000; line discount 10,000; taxable 990,000; 5% = 49,500; line total 1,039,500; overall discount 20,000
    expect(b.lines[0]).toMatchObject({ discountP: 10_000, taxP: 49_500, lineTotalP: 1_039_500 });
    expect(b).toMatchObject({ subtotalP: 1_000_000, itemDiscountsP: 10_000, invoiceDiscountP: 20_000, discountAmountP: 30_000, taxP: 49_500, totalP: 1_000_000 - 30_000 + 49_500 });
  });
});

describe("Received = 0 posts the bill only; a part delivery moves only the bags that arrived", () => {
  it("an ORDER (received 0): status ORDERED, no stock, the supplier is still owed, and the average falls back to the bill's own unit (legacy fall-back)", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await seedStock(h, p.id, s.wh.id, 10, { avgCostP: 50_000 }); // 10 bags that came in through the warehouse app, average 500
    const b = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 20, receivedQuantity: 0, unitPriceP: 100_000 }], { freightP: 20_000 });
    expect(b).toMatchObject({ status: "ORDERED", stockApplied: false, orderedQuantity: 20, receivedQuantity: 0, totalP: 2_020_000 });
    expect(b.lines[0]).toMatchObject({ quantity: 20, receivedQuantity: 0, receivedQtyMilli: 0 });
    expect(await purMovements(h, b.id)).toEqual([]);
    expect(await levelOf(h, p.id, s.wh.id)).toBe(10_000);
    // the bill is on the supplier's account even though nothing arrived
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(2_020_000);
    expect(await entriesFor(h.admin, "PURCHASE", b.id)).toHaveLength(1);
    // no received bag anywhere: goods 100,000, charge share 20,000 over the ORDERED bags -> landed 100,000 + 1,000 = 101,000: that becomes the average AND the last cost
    expect(b.lines[0]).toMatchObject({ goodsUnitCostP: 100_000, chargeShareP: 20_000, landedUnitCostP: 101_000 });
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 101_000, last: 101_000 });
  });

  it("an order into a godown with no stock row creates a zero row (level 0 = Σ movements 0) carrying the bill's cost", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 5, receivedQuantity: 0, unitPriceP: 80_000 }]);
    expect(await levelOf(h, p.id, s.wh.id)).toBe(0);
    expect(await movementSum(h, p.id, s.wh.id)).toBe(0);
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 80_000, last: 80_000 });
  });

  it("a PART DELIVERY (100 ordered @ 1,000, 60 arrived, freight 600): status PARTIALLY_RECEIVED, 60 bags in, goods unit 1,000 (fix 3: line value / ORDERED bags), landed 1,010", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const b = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, receivedQuantity: 60, unitPriceP: 100_000 }], { freightP: 60_000 });
    expect(b).toMatchObject({ status: "PARTIALLY_RECEIVED", orderedQuantity: 100, receivedQuantity: 60, totalP: 10_060_000, stockApplied: true });
    // legacy goods unit = 10,000,000 / 60 = 166,667 (overstated); fixed = 10,000,000 / 100 = 100,000. Charges over the 60 RECEIVED bags: 60,000 / 60 = 1,000
    expect(b.lines[0]).toMatchObject({ goodsUnitCostP: 100_000, chargeShareP: 60_000, landedUnitCostP: 101_000 });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(60_000);
    expect(await purMovements(h, b.id)).toMatchObject([{ kind: "PURCHASE_IN", q: 60_000, cost: 100_000 }]);
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 101_000, last: 101_000 });
  });

  it("received above ordered is not capped (the legacy allowed it): status RECEIVED, all the received bags come in", async () => {
    const s = await purScenario(h, 1);
    const b = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 10, receivedQuantity: 12, unitPriceP: 100_000 }]);
    expect(b).toMatchObject({ status: "RECEIVED", receivedQuantity: 12 });
    expect(await levelOf(h, s.ps[0]!.id, s.wh.id)).toBe(12_000);
  });

  it("a zero rate is allowed (the legacy only refused a negative one): the movement records no cost", async () => {
    const s = await purScenario(h, 1);
    const b = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 4, unitPriceP: 0 }]);
    expect(b.totalP).toBe(0);
    expect((await purMovements(h, b.id))[0]).toMatchObject({ q: 4_000, cost: null });
  });
});

describe("average cost is recomputed from every purchase line, never nudged", () => {
  it("bags that came in through the warehouse do not blend in: 10 carried bags @ 500, then 100 bought @ 1,000 -> average 1,000, level 110", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await seedStock(h, p.id, s.wh.id, 10, { avgCostP: 50_000 });
    await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, unitPriceP: 100_000 }]);
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 100_000, last: 100_000 });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(110_000);
  });

  it("two purchases of one product into one godown: (100 x 1,000 + 100 x 3,000) / 200 = 2,000; last cost = the latest line's 3,000", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, unitPriceP: 100_000 }]);
    await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, unitPriceP: 300_000 }]);
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 200_000, last: 300_000 });
  });

  it("a part delivery weighs by the bags that ARRIVED: 100 @ 1,000 (all in) + 100 ordered @ 3,000 of which 50 arrived -> (100,000 + 50 x 3,000) / 150 = 1,667 (fix 3: unit 3,000, not 6,000)", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, unitPriceP: 100_000 }]);
    await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, receivedQuantity: 50, unitPriceP: 300_000 }]);
    // (100 x 100,000 + 50 x 300,000) / 150 = 25,000,000 / 150 = 166,666.67 -> 166,667
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 166_667, last: 300_000 });
  });

  it("PURCHASE basis: the goods price alone (no freight): freight 60,000 on 60 bags @ 1,000 -> unit 1,000, not 1,010", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await withCostBasis(h, "PURCHASE", async () => {
      await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 60, unitPriceP: 100_000 }], { freightP: 60_000 });
    });
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 100_000, last: 100_000 });
  });

  it("LANDED basis (the real one): the same purchase costs 1,000 + round(60,000 / 60) = 1,010 a bag", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    await withCostBasis(h, "LANDED", async () => {
      await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 60, unitPriceP: 100_000 }], { freightP: 60_000 });
    });
    expect(await costsOf(h, p.id, s.wh.id)).toEqual({ avg: 101_000, last: 101_000 });
  });

  it("the damaged bucket and a row this purchase does not touch are never touched", async () => {
    const s = await purScenario(h, 2);
    const [A, B] = s.ps as [typeof s.ps[number], typeof s.ps[number]];
    await seedStock(h, B.id, s.wh.id, 7, { avgCostP: 12_345 });
    await h.admin`INSERT INTO stock_levels (product_id, warehouse_id, bucket, qty_milli, avg_cost_p) VALUES (${A.id}, ${s.wh.id}, 'damaged', 3000, 999)`;
    await mkPurchase(h, owner, s, [{ productId: A.id, quantity: 5, unitPriceP: 100_000 }]);
    expect(await costsOf(h, B.id, s.wh.id)).toEqual({ avg: 12_345, last: 0 });
    const [dmg] = await h.admin`SELECT qty_milli::int AS q, avg_cost_p::int AS a FROM stock_levels WHERE product_id = ${A.id} AND warehouse_id = ${s.wh.id} AND bucket = 'damaged'`;
    expect(dmg).toEqual({ q: 3000, a: 999 });
  });
});

describe("the payment made with the purchase", () => {
  it("no money: no voucher, status UNPAID; paid in full: PAID", async () => {
    const s = await purScenario(h, 1);
    const line = { productId: s.ps[0]!.id, quantity: 10, unitPriceP: 100_000 };
    const unpaid = await mkPurchase(h, owner, s, [line]);
    expect(unpaid).toMatchObject({ paidP: 0, paymentStatus: "UNPAID", balanceP: 1_000_000 });
    expect(await vouchersFor(h, unpaid.id)).toEqual([]);
    const paid = await mkPurchase(h, owner, s, [line], { paidAmountP: 1_000_000 });
    expect(paid).toMatchObject({ paidP: 1_000_000, paymentStatus: "PAID", balanceP: 0 });
    expect((await vouchersFor(h, paid.id))[0]).toMatchObject({ method: "Cash", reference: null }); // the method defaults to Cash; no supplier bill number, no reference
  });

  it("paid more than the total is refused on a NEW purchase too, in the legacy edit wording; nothing is written", async () => {
    const s = await purScenario(h, 1);
    const before = await h.admin`SELECT count(*)::int AS n FROM purchases WHERE supplier_id = ${s.supplier.id}`;
    const r = await postPur(h, owner, purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 }], { paidAmountP: 100_001 }));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(["The amount paid is more than the purchase total. Record the extra as a separate payment to the supplier."]);
    const after = await h.admin`SELECT count(*)::int AS n FROM purchases WHERE supplier_id = ${s.supplier.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("a negative amount paid is refused", async () => {
    const s = await purScenario(h, 1);
    const r = await postPur(h, owner, purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 }], { paidAmountP: -1 }));
    expect(r.status).toBe(422);
    expect(r.body.errors).toContain("The amount paid cannot be negative.");
  });
});

describe("idempotency: a repeated save is the first save", () => {
  it("the same key twice: 201 then 200, the same purchase, one set of lines, movements, journal and voucher", async () => {
    const s = await purScenario(h, 1);
    const key = newKey();
    const body = purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 5, unitPriceP: 100_000 }], { paidAmountP: 100_000, idempotencyKey: key });
    const a = await postPur(h, owner, body);
    const b = await postPur(h, owner, body);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.id).toBe(a.body.id);
    expect(await purMovements(h, a.body.id)).toHaveLength(1);
    expect(await entriesFor(h.admin, "PURCHASE", a.body.id)).toHaveLength(1);
    expect(await vouchersFor(h, a.body.id)).toHaveLength(1);
    expect(await levelOf(h, s.ps[0]!.id, s.wh.id)).toBe(5_000);
    const n = await h.admin`SELECT count(*)::int AS n FROM purchases WHERE supplier_id = ${s.supplier.id}`;
    expect(n[0]!.n).toBe(1);
  });

  it("a key already used by an invoice save is refused, not mistaken for a purchase", async () => {
    const s = await purScenario(h, 1);
    const key = newKey();
    const shop = await h.seed.customer();
    await seedStock(h, s.ps[0]!.id, s.wh.id, 5);
    const inv = await h.request(owner, "POST", "/invoices", { body: { mode: "post", customerId: shop.id, warehouseId: s.wh.id, lines: [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 }], idempotencyKey: key } });
    expect(inv.status).toBe(201);
    const r = await postPur(h, owner, purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 }], { idempotencyKey: key }));
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatch(/already used for something else/);
  });
});

describe("the purchase number prefix comes from the company setting (legacy purchasePrefix), default PUR", () => {
  it("a setting of 'BUY' numbers the purchase BUY-2026-…", async () => {
    const s = await purScenario(h, 1);
    let b: any;
    await withCostBasis(h, "LANDED", async () => {
      b = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 }]);
    }, { purchasePrefix: "BUY" });
    expect(b.number).toMatch(/^BUY-2026-\d{6}$/);
  });
});

void seedProduct;
