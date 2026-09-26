import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { runImport, type Backup } from "@farooq/import";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";
import { carriedCost, costOf, saleCostOf } from "../src/invoices/stock.js";
import { createHarness, type Harness } from "./helpers/harness.js";

/**
 * S14 (old repo `b2b0778`): the committed fixture holds one edited Add-stock receipt — RCV-2026-000004, p-1 @ wh-2, 30 bags @ 800.00
 * edited to 30 @ 900.00 (movements +30 @ 80,000, RECEIPT_EDIT_OUT −30 @ 80,000, +30 @ 90,000; the header of `build-fixture.ts` names it).
 * This proves the importer, `carriedCost` and `costOf` see it together, by hand:
 *   carried cost p-1@wh-2 = (30 x 80,000 − 30 x 80,000 + 30 x 90,000) / 30 = 90,000   (NOT 85,000, the mean of both receipts)
 *   `costOf` p-1@wh-2     = 80,000, the stock row's own recorded average outranks the carried cost (first hit wins)
 *   p-2@wh-1 (an unedited ADJUSTMENT_IN of 60 @ 85,000) is untouched: 85,000
 * It imports the fixture, which wipes the business tables — nothing else in this file needs them.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await runImport(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "receipt-edit-fixture" });
});
afterAll(async () => {
  await h.close();
});

const ids = async (product: string, warehouse: string) => {
  const [r] = await h.admin`SELECT p.id AS p, w.id AS w FROM products p, warehouses w WHERE p.legacy_id = ${product} AND w.legacy_id = ${warehouse}`;
  return { p: r!.p as string, w: r!.w as string };
};

describe("the fixture's edited receipt", () => {
  it("carried cost p-1@wh-2 = 90,000: the corrected cost REPLACES the old one", async () => {
    const k = await ids("p-1", "wh-2");
    expect(await carriedCost(h.db, k.p, k.w)).toBe(90_000);
  });

  it("costOf still reads the row's recorded average first (80,000); the sale adds p-1's extra of 2,000 (S6 prices panel) → 82,000", async () => {
    const k = await ids("p-1", "wh-2");
    expect(await costOf(h.db, k.p, k.w)).toBe(80_000);
    expect(await saleCostOf(h.db, k.p, k.w)).toEqual({ costP: 82_000, stockCostP: 80_000, extraP: 2_000 });
  });

  it("a receipt that was never edited carries its own cost: p-2@wh-1 = 85,000", async () => {
    const k = await ids("p-2", "wh-1");
    expect(await carriedCost(h.db, k.p, k.w)).toBe(85_000);
  });

  it("with the recorded average removed, costOf falls to the carried cost — 90,000 for the edited receipt", async () => {
    const k = await ids("p-1", "wh-2");
    await h.admin`UPDATE stock_levels SET avg_cost_p = 0 WHERE product_id = ${k.p} AND warehouse_id = ${k.w} AND bucket = 'stock'`;
    expect(await costOf(h.db, k.p, k.w)).toBe(90_000);
  });
});
