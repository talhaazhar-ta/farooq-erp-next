import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stockLevels, stockMovements } from "@farooq/db";
import { carriedCost, costOf } from "../src/invoices/stock.js";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { invBody, mkPosted, post, scenario, seedProduct, seedStock, seedWarehouse } from "./helpers/invoices.js";

/**
 * `Inventory.costOf(pid, wid)` / `carriedCost` (02-services.js 131-169) ported as READS over stock_levels / stock_movements.
 * Each branch of the fallback order gets a test with hand-computed figures; the invoice line's `costSnapshot` is checked to be exactly this.
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

const move = (productId: string, warehouseId: string, kind: string, qtyMilli: number, unitCostP: number | null, bucket = "stock") =>
  h.db.insert(stockMovements).values({ date: "2026-01-02", productId, warehouseId, kind, bucket, qtyDeltaMilli: qtyMilli, unitCostP, ref: "t", refType: "MIGRATION" });

describe("costOf — the legacy priority order, first hit wins", () => {
  it("1. the row's own recorded average cost outranks everything (even a carried cost in the same godown)", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h, { buyP: 100 });
    await seedStock(h, p.id, wh.id, 10, { avgCostP: 260_000, movementCostP: 200_000 });
    expect(await costOf(h.db, p.id, wh.id)).toBe(260_000);
  });

  it("2. no average: this godown's carried cost — the weighted mean of costed OPENING / ADJUSTMENT_IN / TRANSFER_IN / CONVERT_IN arrivals", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h, { buyP: 100 });
    await seedStock(h, p.id, wh.id, 10, { movementCostP: 200_000 }); // opening: 10 bags @ 2,000
    await move(p.id, wh.id, "ADJUSTMENT_IN", 10_000, 300_000); // 10 @ 3,000
    // noise that must NOT count: a PURCHASE_IN (not a carried kind), the damaged bucket, a departure, an arrival with no cost, a zero cost
    await move(p.id, wh.id, "PURCHASE_IN", 50_000, 900_000);
    await move(p.id, wh.id, "ADJUSTMENT_IN", 5_000, 900_000, "damaged");
    await move(p.id, wh.id, "TRANSFER_IN", -5_000, 900_000);
    await move(p.id, wh.id, "TRANSFER_IN", 5_000, null);
    await move(p.id, wh.id, "CONVERT_IN", 5_000, 0);
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(250_000); // (10×2,000 + 10×3,000) / 20 = 2,500
    expect(await costOf(h.db, p.id, wh.id)).toBe(250_000);
  });

  it("2b. the mean is rounded to a whole paisa: 3 bags @ 1,000.00 + 4 @ 1,001.00 → 1,000.571… → 1,001 (in paisa: 100,057.1 → 100,057)", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h);
    await seedStock(h, p.id, wh.id, 3, { movementCostP: 100_000 });
    await move(p.id, wh.id, "ADJUSTMENT_IN", 4_000, 100_100);
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(Math.round((3 * 100_000 + 4 * 100_100) / 7)); // 100,057
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(100_057);
  });

  it("2c. this godown's carried cost outranks ANOTHER godown's recorded average (legacy comment: the same priority Stock value uses)", async () => {
    const wh1 = await seedWarehouse(h);
    const wh2 = await seedWarehouse(h);
    const p = await seedProduct(h, { buyP: 100 });
    await seedStock(h, p.id, wh1.id, 5, { movementCostP: 200_000 });
    await seedStock(h, p.id, wh2.id, 5, { avgCostP: 270_000 });
    expect(await costOf(h.db, p.id, wh1.id)).toBe(200_000);
  });

  it("3. nothing in this godown: another godown's recorded average (deterministic: the lowest godown id when several)", async () => {
    const [a, b, c] = [await seedWarehouse(h), await seedWarehouse(h), await seedWarehouse(h)];
    const p = await seedProduct(h, { buyP: 100 });
    await seedStock(h, p.id, a.id, 5); // no cost here
    await seedStock(h, p.id, b.id, 5, { avgCostP: 270_000 });
    await seedStock(h, p.id, c.id, 5, { avgCostP: 290_000 });
    const lowest = [b, c].sort((x, y) => (x.id < y.id ? -1 : 1))[0]!;
    expect(await costOf(h.db, p.id, a.id)).toBe(lowest === b ? 270_000 : 290_000);
  });

  it("4. nothing anywhere: the product's list buy price (`products.buy_p`)", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h, { buyP: 240_000 });
    expect(await costOf(h.db, p.id, wh.id)).toBe(240_000);
    await seedStock(h, p.id, wh.id, 3); // a level row with no cost changes nothing
    expect(await costOf(h.db, p.id, wh.id)).toBe(240_000);
  });

  it("5. nothing at all → 0 (an unset or zero buy price is 'unknown')", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h, {});
    expect(await costOf(h.db, p.id, wh.id)).toBe(0);
    const zero = await seedProduct(h, { buyP: 0 });
    expect(await costOf(h.db, zero.id, wh.id)).toBe(0);
  });

  it("a zero recorded average is 'not recorded' and falls through", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h, { buyP: 111_000 });
    await h.db.insert(stockLevels).values({ productId: p.id, warehouseId: wh.id, bucket: "stock", qtyMilli: 0, avgCostP: 0 });
    expect(await costOf(h.db, p.id, wh.id)).toBe(111_000);
  });
});

describe("carriedCost after an edited Add-stock receipt (S14, old repo b2b0778 — `RECEIPT_EDIT_OUT`)", () => {
  // The legacy `test-receipt-edit.mjs` case in paisa: a receipt of 10 @ 500.00, edited to 10 @ 600.00. `editReceive` takes the old
  // lines back out AT THEIR OLD COST (RECEIPT_EDIT_OUT) and posts the corrected ones (ADJUSTMENT_IN), so the corrected cost REPLACES the old one.
  it("10 @ 500 edited to 10 @ 600 → carried 600, not the 550 an average of both would give", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h);
    await move(p.id, wh.id, "ADJUSTMENT_IN", 10_000, 50_000);
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(50_000);
    await move(p.id, wh.id, "RECEIPT_EDIT_OUT", -10_000, 50_000);
    await move(p.id, wh.id, "ADJUSTMENT_IN", 10_000, 60_000);
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(60_000); // (10×500 − 10×500 + 10×600) / 10
    expect(await costOf(h.db, p.id, wh.id)).toBe(60_000);
  });

  it("a receipt edited down to no lines carries nothing (net qty 0) — costOf falls through to the list buy price", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h, { buyP: 111_000 });
    await move(p.id, wh.id, "ADJUSTMENT_IN", 10_000, 50_000);
    await move(p.id, wh.id, "RECEIPT_EDIT_OUT", -10_000, 50_000);
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(0);
    expect(await costOf(h.db, p.id, wh.id)).toBe(111_000);
  });

  it("edited down to fewer bags: 10 @ 500 → 6 @ 500 carries 500 (the reversal takes 10 out, 6 go in)", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h);
    await move(p.id, wh.id, "ADJUSTMENT_IN", 10_000, 50_000);
    await move(p.id, wh.id, "RECEIPT_EDIT_OUT", -10_000, 50_000);
    await move(p.id, wh.id, "ADJUSTMENT_IN", 6_000, 50_000);
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(50_000);
  });

  it("the result is a cost only when BOTH the net qty and the net cost are > 0 (a reversal costed higher than what came in is 0, never a negative cost)", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h);
    await move(p.id, wh.id, "ADJUSTMENT_IN", 10_000, 10_000); // cost 100,000
    await move(p.id, wh.id, "ADJUSTMENT_IN", 5_000, 5_000); // +25,000
    await move(p.id, wh.id, "RECEIPT_EDIT_OUT", -10_000, 20_000); // −200,000  → qty 5, cost −75,000
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(0);
  });

  it("noise that must not count: a reversal with no cost, in the damaged bucket, or (impossible in the legacy) with a positive qty", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h);
    await move(p.id, wh.id, "ADJUSTMENT_IN", 10_000, 50_000);
    await move(p.id, wh.id, "RECEIPT_EDIT_OUT", -4_000, null); // the old line had no cost: nothing to take back
    await move(p.id, wh.id, "RECEIPT_EDIT_OUT", -4_000, 90_000, "damaged");
    await move(p.id, wh.id, "RECEIPT_EDIT_OUT", 4_000, 90_000); // not a carried kind with qty > 0
    expect(await carriedCost(h.db, p.id, wh.id)).toBe(50_000);
  });

  it("a reversal in ANOTHER godown does not touch this godown's carried cost", async () => {
    const [a, b] = [await seedWarehouse(h), await seedWarehouse(h)];
    const p = await seedProduct(h);
    await move(p.id, a.id, "ADJUSTMENT_IN", 10_000, 50_000);
    await move(p.id, b.id, "ADJUSTMENT_IN", 10_000, 70_000);
    await move(p.id, b.id, "RECEIPT_EDIT_OUT", -10_000, 70_000);
    expect(await carriedCost(h.db, p.id, a.id)).toBe(50_000);
  });
});

describe("the invoice line's cost snapshot is that figure, taken from the LINE's godown", () => {
  it("a sale from a godown with a carried cost of 2,500 snapshots 250,000; from one with nothing, the list price", async () => {
    const s = await scenario(h, { buyP: 240_000, stock: 1 });
    await h.admin`DELETE FROM stock_levels WHERE product_id = ${s.product.id}`;
    await h.admin`DELETE FROM stock_movements WHERE product_id = ${s.product.id}`;
    const costed = await seedWarehouse(h);
    await seedStock(h, s.product.id, costed.id, 20, { movementCostP: 250_000 });
    await seedStock(h, s.product.id, s.wh.id, 20);
    const r = await post(
      h,
      owner,
      invBody(s.shop.id, s.wh.id, [
        { productId: s.product.id, quantity: 1, unitPriceP: 300_000, warehouseId: costed.id },
        { productId: s.product.id, quantity: 1, unitPriceP: 300_000 },
      ]),
    );
    expect(r.status).toBe(201);
    expect(r.body.lines.map((l: any) => l.costSnapshotP)).toEqual([250_000, 240_000]);
  });

  it("`avg_cost_p` is never modified by a sale (average-cost maintenance is M4)", async () => {
    const s = await scenario(h, { stock: 10 });
    await h.admin`UPDATE stock_levels SET avg_cost_p = 260000, last_cost_p = 255000 WHERE product_id = ${s.product.id}`;
    await mkPosted(h, owner, s, { qty: 3, unitPriceP: 300_000 });
    const [row] = await h.admin`SELECT avg_cost_p::int AS a, last_cost_p::int AS l FROM stock_levels WHERE product_id = ${s.product.id}`;
    expect(row).toEqual({ a: 260_000, l: 255_000 });
  });
});
