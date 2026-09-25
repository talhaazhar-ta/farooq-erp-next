import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, purchaseDetailSchema, purchaseRateSchema } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { seedWarehouse } from "./helpers/invoices.js";
import { getPur, mkPurchase, purEditBody, purScenario, putPur } from "./helpers/purchases.js";

/** `GET /purchases/:id` and `GET /purchases/last-rates` — shape, what each role sees, what each role may do, and the 404s. */
let h: Harness;
let owner: Session;
let accountant: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  accountant = await h.session("ACCOUNTANT");
});
afterAll(async () => {
  await h.close();
});

/** Runs `fn` with a permission taken away from a role (the arrays are the ones the guard and the service read), then puts it back. */
async function without(role: "ACCOUNTANT" | "MANAGER", permission: Parameters<(typeof ROLE_PERMISSIONS)["MANAGER"]["includes"]>[0], fn: () => Promise<void>) {
  const perms = ROLE_PERMISSIONS[role];
  const kept = [...perms];
  perms.splice(perms.indexOf(permission), 1);
  try {
    await fn();
  } finally {
    perms.length = 0;
    perms.push(...kept);
  }
}

describe("GET /purchases/:id", () => {
  it("the detail matches its schema and carries the header, lines, vouchers, stock effect and actions", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const pu = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000, discountP: 10_000 }], { freightP: 20_000, paidAmountP: 300_000, supplierInvoiceNo: "S-77" });
    const d = purchaseDetailSchema.parse((await getPur(h, owner, pu.id)).body);
    // gross 1,000,000 - 10,000 + freight 20,000 = 1,010,000; the whole 10 bags arrived
    expect(d).toMatchObject({ number: pu.number, status: "RECEIVED", paymentStatus: "PARTIAL", totalP: 1_010_000, paidP: 300_000, balanceP: 710_000, supplierName: s.supplier.companyName, supplierInvoiceNo: "S-77", orderedQuantity: 10, receivedQuantity: 10 });
    expect(d.lines).toHaveLength(1);
    expect(d.payments).toHaveLength(1);
    expect(d.stockMovements).toHaveLength(1);
    expect(d.stockMovements[0]).toMatchObject({ kind: "PURCHASE_IN", quantity: 10, bucket: "stock", productId: p.id, warehouseId: s.wh.id });
    expect(d.actions).toEqual({ edit: { allowed: true, reason: null } });
  });

  it("PROFIT_VIEW roles see the cost figures and the stock row's averages", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const pu = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }], { freightP: 20_000 });
    for (const who of [owner, accountant]) {
      const d = (await getPur(h, who, pu.id)).body;
      expect(d.lines[0]).toMatchObject({ goodsUnitCostP: 100_000, chargeShareP: 20_000, landedUnitCostP: 102_000 });
      expect(d.costs).toEqual({ basis: "LANDED", stock: [{ productId: p.id, warehouseId: s.wh.id, avgCostP: 102_000, lastCostP: 102_000 }] });
      expect(d.stockMovements[0].unitCostP).toBe(100_000);
    }
  });

  it("a reader WITHOUT PROFIT_VIEW gets a detail with NO cost keys at all (absent, not null)", async () => {
    const s = await purScenario(h, 1);
    const pu = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 10, unitPriceP: 100_000 }], { freightP: 20_000 });
    await without("ACCOUNTANT", "PROFIT_VIEW", async () => {
      const r = await getPur(h, accountant, pu.id);
      expect(r.status).toBe(200);
      const d = r.body;
      expect(d).not.toHaveProperty("costs");
      for (const l of d.lines) for (const k of ["goodsUnitCostP", "chargeShareP", "landedUnitCostP", "operationalShareP"]) expect(l, k).not.toHaveProperty(k);
      for (const m of d.stockMovements) expect(m).not.toHaveProperty("unitCostP");
      const blob = JSON.stringify(d);
      for (const k of ["goodsUnitCost", "chargeShare", "landedUnitCost", "operationalShare", "avgCost", "lastCost", "unitCostP", "\"costs\""]) expect(blob, k).not.toContain(k);
      purchaseDetailSchema.parse(d); // still a valid detail
    });
  });

  it("a reader who may not edit sees the server's own reason on actions.edit; a cancelled purchase says it cannot be edited", async () => {
    const s = await purScenario(h, 1);
    const pu = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 }]);
    await without("ACCOUNTANT", "TRANSACTION_CORRECT", async () => {
      // the accountant still reads it (FINANCIAL_REPORT_VIEW) but may not edit any more
      const d = (await getPur(h, accountant, pu.id)).body;
      expect(d.actions.edit).toEqual({ allowed: false, reason: "You do not have permission to edit a purchase." });
      expect((await putPur(h, accountant, pu.id, purEditBody(pu))).status).toBe(403);
    });
    const c = await h.seed.purchase(s.supplier.id, { totalP: 1_000, status: "CANCELLED" });
    expect((await getPur(h, owner, c.id)).body.actions.edit).toEqual({ allowed: false, reason: "A cancelled purchase cannot be edited." });
  });

  it("an imported purchase (header only, no lines) reads fine, with the discount split the way the legacy form split it", async () => {
    const s = await purScenario(h, 1);
    const c = await h.seed.purchase(s.supplier.id, { totalP: 500_000, number: "PUR-OLD-READ-1" });
    await h.admin`UPDATE purchases SET discount_amount_p = 40000 WHERE id = ${c.id}`;
    const d = purchaseDetailSchema.parse((await getPur(h, owner, c.id)).body);
    expect(d).toMatchObject({ number: "PUR-OLD-READ-1", lines: [], itemDiscountsP: 0, invoiceDiscountP: 40_000, discountAmountP: 40_000, revision: 0 });
  });

  it("404 (same shape as elsewhere) for an unknown or malformed id", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const r = await getPur(h, owner, id);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ message: "Purchase not found.", errors: ["Purchase not found."] });
    }
    const put = await putPur(h, owner, "00000000-0000-4000-8000-000000000000", { supplierId: "x", warehouseId: "y", lines: [] });
    expect(put.status).toBe(422); // the body is checked first, as everywhere else
  });
});

describe("GET /purchases/last-rates", () => {
  it("the rate of the newest non-cancelled purchase line of each product; a product never bought is absent; a cancelled purchase does not count", async () => {
    const s = await purScenario(h, 3);
    const [A, B, C] = s.ps as [typeof s.ps[number], typeof s.ps[number], typeof s.ps[number]];
    const old = await mkPurchase(h, owner, s, [{ productId: A.id, quantity: 1, unitPriceP: 100_000 }], { date: "2026-01-10" });
    const newer = await mkPurchase(h, owner, s, [{ productId: A.id, quantity: 1, unitPriceP: 130_000 }, { productId: B.id, quantity: 1, unitPriceP: 50_000 }], { date: "2026-02-20" });
    const cancelled = await mkPurchase(h, owner, s, [{ productId: B.id, quantity: 1, unitPriceP: 99_999 }], { date: "2026-03-01" });
    await h.admin`UPDATE purchases SET status = 'CANCELLED' WHERE id = ${cancelled.id}`;
    const r = await h.request(owner, "GET", `/purchases/last-rates?productIds=${A.id},${B.id},${C.id}`);
    expect(r.status).toBe(200);
    const rates = (r.body as unknown[]).map((x) => purchaseRateSchema.parse(x));
    expect(rates.sort((x, y) => (x.productId < y.productId ? -1 : 1))).toEqual(
      [
        { productId: A.id, unitPriceP: 130_000, date: "2026-02-20", purchaseNumber: newer.number, supplierId: s.supplier.id },
        { productId: B.id, unitPriceP: 50_000, date: "2026-02-20", purchaseNumber: newer.number, supplierId: s.supplier.id },
      ].sort((x, y) => (x.productId < y.productId ? -1 : 1)),
    );
    void old;
  });

  it("no product named, a malformed id, or more than 100: 422", async () => {
    expect((await h.request(owner, "GET", "/purchases/last-rates")).status).toBe(422);
    expect((await h.request(owner, "GET", "/purchases/last-rates?productIds=nope")).status).toBe(422);
    const many = Array.from({ length: 101 }, () => "00000000-0000-4000-8000-000000000000").join(",");
    expect((await h.request(owner, "GET", `/purchases/last-rates?productIds=${many}`)).status).toBe(422);
    void seedWarehouse;
  });
});
