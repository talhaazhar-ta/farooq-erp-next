import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoiceDetailSchema, invoiceProfitSchema, ROLES, type Role } from "@farooq/shared";
import { profitOfInvoice } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { get, invBody, post, put, editBody, scenario, seedProduct, seedStock } from "./helpers/invoices.js";

/**
 * Profit on an invoice (S8 planner decision 3) through the API: `GET /invoices/:id/profit` and the `profit` block of the detail,
 * PROFIT_VIEW only — 403 for everyone else, and for them the KEYS are absent from the JSON (not null), in every response.
 *
 *   product A: cost 240,000 a bag (its buy price), product B: no cost known
 *   10 × A at 300,000 = 3,000,000 · 5 × B at 100,000 = 500,000 · invoice discount 100,000 · freight 50,000 · grand total 3,450,000
 *   adopted:  A revenue 3,000,000 − cost 2,400,000 = 600,000; B has no profit (unknown cost); the discount is shared by revenue:
 *             100,000 × 3,000,000 / 3,500,000 = 85,714 → invoice profit 514,286 on a base of 2,914,286 = 17.65 %; `complete` false
 *   legacy:   grand total 3,450,000 − cost 2,400,000 = 1,050,000 (freight and the unknown-cost bags counted as profit)
 */
let h: Harness;
let owner: Session;
const sessions = {} as Record<Role, Session>;
beforeAll(async () => {
  h = await createHarness();
  for (const r of ROLES) sessions[r] = await h.session(r);
  owner = sessions.OWNER;
});
afterAll(async () => {
  await h.close();
});

const PROFIT_ROLES: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT"];
const LEAKY = /profit|margin|markup|cost/i;
const keysOf = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.flatMap(keysOf))] : v && typeof v === "object" ? [...new Set(Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]))] : []);

async function twoProductInvoice() {
  const s = await scenario(h, { buyP: 240_000 });
  const b = await seedProduct(h, { buyP: undefined });
  await seedStock(h, b.id, s.wh.id, 50);
  const r = await post(
    h,
    owner,
    invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 10, unitPriceP: 300_000 }, { productId: b.id, quantity: 5, unitPriceP: 100_000 }], { invoiceDiscountP: 100_000, freightP: 50_000 }),
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { s, b, inv: r.body };
}

describe("the numbers", () => {
  it("adopted figures by hand: goods margin net of the discount, the unknown-cost line has no profit and is flagged", async () => {
    const { inv } = await twoProductInvoice();
    expect(inv.totalP).toBe(3_450_000);
    const res = await h.request(owner, "GET", `/invoices/${inv.id}/profit`);
    expect(res.status).toBe(200);
    const p = invoiceProfitSchema.parse(res.body);
    expect(p).toMatchObject({ revenueP: 3_500_000, invoiceDiscountP: 100_000, costP: 2_400_000, profitP: 514_286, marginPct: 17.65, complete: false, unknownCostLines: 1 });
    expect(p.lines).toEqual([
      { lineId: inv.lines[0].id, revenueP: 3_000_000, costKnown: true, costP: 2_400_000, profitP: 600_000, marginPct: 20, markupPct: 25 },
      { lineId: inv.lines[1].id, revenueP: 500_000, costKnown: false, costP: null, profitP: null, marginPct: null, markupPct: null },
    ]);
    // the response never carries the legacy figure
    expect(JSON.stringify(res.body)).not.toMatch(/legacy/i);
    // the legacy definition, computed from the same stored lines, on the same invoice
    const legacy = profitOfInvoice({ lines: inv.lines.map((l: any) => ({ qtyMilli: l.qtyMilli, lineTotalP: l.lineTotalP, taxP: l.taxP, costSnapshotP: l.costSnapshotP })), invoiceDiscountP: inv.invoiceDiscountP, grandTotalP: inv.totalP }).legacyProfitP;
    expect(legacy).toBe(1_050_000);
  });

  it("the detail carries the same block for a PROFIT_VIEW role", async () => {
    const { inv } = await twoProductInvoice();
    const d = (await get(h, owner, inv.id)).body;
    invoiceDetailSchema.parse(d);
    expect(d.profit).toEqual((await h.request(owner, "GET", `/invoices/${inv.id}/profit`)).body);
  });

  it("charges and tax do not count: freight on a fully-costed invoice leaves the profit where the goods put it", async () => {
    const s = await scenario(h, { buyP: 100_000 });
    const r = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 4, unitPriceP: 150_000, taxP: 10_000 }], { freightP: 70_000, loadingP: 20_000 }));
    // 4 × 150,000 = 600,000 + tax 10,000 + charges 90,000 = 700,000 grand; goods: 600,000 − 400,000 = 200,000 (33.33 %)
    expect(r.body.totalP).toBe(700_000);
    const p = (await h.request(owner, "GET", `/invoices/${r.body.id}/profit`)).body;
    expect(p).toMatchObject({ revenueP: 600_000, costP: 400_000, profitP: 200_000, marginPct: 33.33, complete: true, unknownCostLines: 0 });
  });

  it("profit is fixed on the sale line: a later price change (the buy price) cannot rewrite last month's profit — an edit re-takes the snapshot, as the legacy did", async () => {
    const { s, inv } = await twoProductInvoice();
    await h.admin`UPDATE products SET buy_p = 500_000 WHERE id = ${s.product.id}`;
    expect((await h.request(owner, "GET", `/invoices/${inv.id}/profit`)).body).toMatchObject({ costP: 2_400_000, profitP: 514_286 });
    const edited = await put(h, owner, inv.id, editBody(inv, { notes: "same lines, new note" }));
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    // the snapshot was re-taken at the edit: the new cost is 500,000 a bag → 10 bags cost 5,000,000
    expect((await h.request(owner, "GET", `/invoices/${inv.id}/profit`)).body).toMatchObject({ costP: 5_000_000 });
  });

  it("a draft and a cancelled invoice can be looked at too; an unknown or malformed id is 404", async () => {
    const s = await scenario(h, { buyP: 100_000 });
    const d = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 2, unitPriceP: 130_000 }], { mode: "draft" }));
    expect((await h.request(owner, "GET", `/invoices/${d.body.id}/profit`)).body).toMatchObject({ profitP: 60_000 });
    expect((await h.request(owner, "GET", "/invoices/00000000-0000-4000-8000-000000000000/profit")).status).toBe(404);
    expect((await h.request(owner, "GET", "/invoices/not-a-uuid/profit")).status).toBe(404);
  });
});

describe("who may see it — the JSON is tested, not just the status", () => {
  it("/profit is 403 for SALES and INVENTORY, 200 for OWNER, MANAGER, ACCOUNTANT (and 401 without a session)", async () => {
    const { inv } = await twoProductInvoice();
    for (const role of ROLES) {
      const res = await h.request(sessions[role], "GET", `/invoices/${inv.id}/profit`);
      expect(res.status, role).toBe(PROFIT_ROLES.includes(role) ? 200 : 403);
    }
    expect((await h.request(null, "GET", `/invoices/${inv.id}/profit`)).status).toBe(401);
  });

  it("without PROFIT_VIEW no response carries a cost, profit or margin key at all: the detail has no `profit` key and a null cost, the list and the print model have none", async () => {
    const { inv } = await twoProductInvoice();
    const sales = sessions.SALES;
    const detail = (await get(h, sales, inv.id)).body;
    expect("profit" in detail).toBe(false);
    expect(Object.keys(detail)).not.toContain("profit");
    expect(detail.lines.every((l: any) => l.costSnapshotP === null)).toBe(true);
    const printed = (await h.request(sales, "GET", `/invoices/${inv.id}/print`)).body;
    const listed = (await h.request(sales, "GET", `/invoices?q=${encodeURIComponent(inv.shop.shopName ?? "")}`)).body;
    const csvHeader = ((await h.request(sales, "GET", "/invoices/export.csv")).body as string).split("\r\n")[0]!;
    // the KEYS, at any depth (a shop that happens to be named "Cost Cutters" is data, not a leak)
    for (const body of [printed, listed]) expect(keysOf(body).filter((k) => LEAKY.test(k))).toEqual([]);
    expect(csvHeader).not.toMatch(LEAKY);
    expect(keysOf(detail).filter((k) => LEAKY.test(k))).toEqual(["costSnapshotP"]); // the line's own cost field is present but null, as since S7
    // — and the roles that CAN see profit do get the key
    for (const role of PROFIT_ROLES) expect("profit" in (await get(h, sessions[role], inv.id)).body).toBe(true);
  });

  it("profit is not a column of the list or the CSV for anyone, the owner included", async () => {
    const list = (await h.request(owner, "GET", "/invoices?limit=5")).body;
    expect(keysOf(list).filter((k) => LEAKY.test(k))).toEqual([]);
    expect(((await h.request(owner, "GET", "/invoices/export.csv")).body as string).split("\r\n")[0]).not.toMatch(LEAKY);
    expect(keysOf((await h.request(owner, "GET", `/invoices/${(list as any).items[0].id}/print`)).body).filter((k) => LEAKY.test(k))).toEqual([]);
  });
});
