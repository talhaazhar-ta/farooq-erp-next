import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { products } from "@farooq/db";
import { eq } from "drizzle-orm";
import { productPickItemSchema } from "@farooq/shared";
import { saleCostOf } from "../src/invoices/stock.js";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { withCostBasis } from "./helpers/cost-basis.js";
import { invBody, mkPosted, post, put, editBody, scenario, seedProduct, seedStock, seedWarehouse } from "./helpers/invoices.js";
import { costsOf, mkPurchase, purScenario } from "./helpers/purchases.js";

/**
 * S14, old repo `c78659b` — a sale is costed at `Inventory.saleCostOf` = `costOf` + the product's extra cost per bag (`products.extra_p`).
 * The client's own example in paisa: stock cost 3,000.00 (300,000) + extra 200.00 (20,000) = 3,200.00 (320,000); a bag sold at
 * 3,500.00 (350,000) earns 300.00 (30,000), not 500.00.
 *
 * What the extra must NOT touch: `avg_cost_p`, `last_cost_p`, the purchase average and the purchase detail's `costs` block.
 * Old invoices keep their snapshot; the extra is skipped under the `PURCHASE` basis and while the stock cost is unknown.
 */
let h: Harness;
let owner: Session;
let sales: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  sales = await h.session("SALES");
});
afterAll(async () => {
  await h.close();
});

/** stock cost 300,000 a bag (a recorded average), extra 20,000. */
async function clientCase(extraP: number | null = 20_000) {
  const s = await scenario(h, { stock: 1, productOpts: extraP === null ? {} : { extraP } });
  await h.admin`DELETE FROM stock_levels WHERE product_id = ${s.product.id}`;
  await h.admin`DELETE FROM stock_movements WHERE product_id = ${s.product.id}`;
  await seedStock(h, s.product.id, s.wh.id, 100, { avgCostP: 300_000 });
  return s;
}

describe("the invoice line's cost snapshot = stock cost + extra", () => {
  it("the client's example: 3,000 + 200 → a snapshot of 3,200; 10 bags at 3,500 = profit 3,000 (300 a bag), not 5,000", async () => {
    const s = await clientCase();
    const inv = await mkPosted(h, owner, s, { qty: 10, unitPriceP: 350_000 });
    expect(inv.lines[0].costSnapshotP).toBe(320_000);
    const profit = (await h.request(owner, "GET", `/invoices/${inv.id}/profit`)).body;
    expect(profit).toMatchObject({ revenueP: 3_500_000, costP: 3_200_000, profitP: 300_000, complete: true });
    expect(profit.lines[0]).toMatchObject({ costP: 3_200_000, profitP: 300_000 });
  });

  it("a product with no extra is costed exactly as before (stock cost alone)", async () => {
    const s = await clientCase(null);
    expect((await mkPosted(h, owner, s, { qty: 1, unitPriceP: 350_000 })).lines[0].costSnapshotP).toBe(300_000);
    const zero = await clientCase(0);
    expect((await mkPosted(h, owner, zero, { qty: 1, unitPriceP: 350_000 })).lines[0].costSnapshotP).toBe(300_000);
  });

  it("the cost the extra is added to can come from any step of costOf, e.g. the list buy price", async () => {
    const s = await scenario(h, { buyP: 240_000, productOpts: { extraP: 15_000 } });
    expect((await mkPosted(h, owner, s, { qty: 1, unitPriceP: 300_000 })).lines[0].costSnapshotP).toBe(255_000);
  });

  it("under the PURCHASE basis ('purchase price only') the extra is left out", async () => {
    const s = await clientCase();
    await withCostBasis(h, "PURCHASE", async () => {
      expect((await mkPosted(h, owner, s, { qty: 1, unitPriceP: 350_000 })).lines[0].costSnapshotP).toBe(300_000);
    });
    // and the LANDED basis (the default) adds it again
    await withCostBasis(h, "LANDED", async () => {
      expect((await mkPosted(h, owner, s, { qty: 1, unitPriceP: 350_000 })).lines[0].costSnapshotP).toBe(320_000);
    });
  });

  it("an UNKNOWN stock cost stays unknown — the extra alone is not a cost price (no snapshot, no profit shown)", async () => {
    const s = await scenario(h, { stock: 10, productOpts: { extraP: 20_000 } });
    await h.db.update(products).set({ buyP: null }).where(eq(products.id, s.product.id));
    const inv = await mkPosted(h, owner, s, { qty: 2, unitPriceP: 350_000 });
    expect(inv.lines[0].costSnapshotP).toBe(0);
    const profit = (await h.request(owner, "GET", `/invoices/${inv.id}/profit`)).body;
    expect(profit).toMatchObject({ complete: false, unknownCostLines: 1, profitP: null });
    expect(await saleCostOf(h.db, s.product.id, s.wh.id)).toEqual({ costP: 0, stockCostP: 0, extraP: 0 });
  });

  it("an old invoice keeps its snapshot when the extra changes later; an edit re-costs at today's figures (as the legacy always did)", async () => {
    const s = await clientCase();
    const inv = await mkPosted(h, owner, s, { qty: 10, unitPriceP: 350_000 });
    await h.db.update(products).set({ extraP: 50_000 }).where(eq(products.id, s.product.id));
    const again = (await h.request(owner, "GET", `/invoices/${inv.id}`)).body;
    expect(again.lines[0].costSnapshotP).toBe(320_000);
    expect((await h.request(owner, "GET", `/invoices/${inv.id}/profit`)).body).toMatchObject({ profitP: 300_000 });
    const edited = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 10, unitPriceP: 350_000, warehouseId: s.wh.id }]));
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.lines[0].costSnapshotP).toBe(350_000); // 300,000 + the new 50,000
  });
});

describe("what the extra does NOT touch", () => {
  it("a sale never writes avg_cost_p / last_cost_p", async () => {
    const s = await clientCase();
    await h.admin`UPDATE stock_levels SET last_cost_p = 295000 WHERE product_id = ${s.product.id}`;
    await mkPosted(h, owner, s, { qty: 3, unitPriceP: 350_000 });
    expect(await costsOf(h, s.product.id, s.wh.id)).toEqual({ avg: 300_000, last: 295_000 });
  });

  it("a purchase of a product that has an extra: the average, last cost and the purchase detail's costs block carry the goods only", async () => {
    const ps = await purScenario(h, 1);
    await h.db.update(products).set({ extraP: 20_000 }).where(eq(products.id, ps.ps[0]!.id));
    const pu = await mkPurchase(h, owner, ps, [{ productId: ps.ps[0]!.id, quantity: 10, unitPriceP: 300_000 }]);
    expect(await costsOf(h, ps.ps[0]!.id, ps.wh.id)).toEqual({ avg: 300_000, last: 300_000 });
    expect(pu.costs).toEqual({ basis: "LANDED", stock: [{ productId: ps.ps[0]!.id, warehouseId: ps.wh.id, avgCostP: 300_000, lastCostP: 300_000 }] });
    expect(pu.lines[0]).toMatchObject({ goodsUnitCostP: 300_000, landedUnitCostP: 300_000 });
    // ...while a sale of it from that godown is costed at 3,200
    const shop = await h.seed.customer();
    const sale = await post(h, owner, invBody(shop.id, ps.wh.id, [{ productId: ps.ps[0]!.id, quantity: 1, unitPriceP: 350_000 }]));
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.lines[0].costSnapshotP).toBe(320_000);
    expect(await costsOf(h, ps.ps[0]!.id, ps.wh.id)).toEqual({ avg: 300_000, last: 300_000 });
  });
});

describe("GET /products — the builder's price hint figures", () => {
  it("PROFIT_VIEW sees costP = stock + extra with the breakdown; everyone else gets none of it (keys absent)", async () => {
    const s = await clientCase();
    const list = async (as: Session) => {
      const r = await h.request(as, "GET", `/products?ids=${s.product.id}&warehouseId=${s.wh.id}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return productPickItemSchema.parse(r.body[0]);
    };
    const asOwner = await list(owner);
    expect(asOwner).toMatchObject({ costP: 320_000, stockCostP: 300_000, extraP: 20_000 });
    const asSales = await list(sales);
    expect(asSales.costP).toBeNull();
    expect(asSales).not.toHaveProperty("stockCostP");
    expect(asSales).not.toHaveProperty("extraP");
    const raw = (await h.request(sales, "GET", `/products?ids=${s.product.id}&warehouseId=${s.wh.id}`)).body[0];
    expect(Object.keys(raw)).not.toContain("extraP");
    expect(Object.keys(raw)).not.toContain("stockCostP");
  });

  it("an unknown stock cost: costP 0 and extraP 0 (the hint says 'no purchase cost recorded'); PURCHASE basis: extraP 0", async () => {
    const wh = await seedWarehouse(h);
    const p = await seedProduct(h, { extraP: 20_000 });
    await seedStock(h, p.id, wh.id, 5);
    const one = async () => (await h.request(owner, "GET", `/products?ids=${p.id}&warehouseId=${wh.id}`)).body[0];
    expect(await one()).toMatchObject({ costP: 0, stockCostP: 0, extraP: 0 });
    const q = await clientCase();
    await withCostBasis(h, "PURCHASE", async () => {
      const r = (await h.request(owner, "GET", `/products?ids=${q.product.id}&warehouseId=${q.wh.id}`)).body[0];
      expect(r).toMatchObject({ costP: 300_000, stockCostP: 300_000, extraP: 0 });
    });
  });
});
