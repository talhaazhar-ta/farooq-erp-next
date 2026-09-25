import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { exitCodeFor, formatReport, reconcile, runImport, type ReconciliationReport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * "Every new check must be shown to bite" (S6's rule, applied to S11's three checks): each test imports the fixture fresh, proves it
 * is green, damages ONE thing directly in the database (as the admin role) or in the backup the report is checked against, and asserts
 * the report names exactly that purchase / product and exits non-zero.
 */
const sql = adminSql();

beforeEach(async () => {
  await runImport(fixture(), IMPORT_OPTS);
  const r = await reconcile(fixture(), TEST_ADMIN_URL);
  expect(r.ok).toBe(true); // green before we break it
});
afterAll(async () => {
  await sql.end();
});

const check = (backup = fixture()) => reconcile(backup, TEST_ADMIN_URL);
const red = (r: ReconciliationReport) => {
  expect(r.ok).toBe(false);
  expect(exitCodeFor(r)).toBe(1);
  expect(formatReport(r)).toContain("RESULT: FAIL");
};

describe("purchase totals: lines vs header", () => {
  it("a changed line price names exactly that purchase (grand total, subtotal and that line's total all disagree)", async () => {
    await sql`UPDATE purchase_items SET unit_price_p = 60001 WHERE legacy_id = 'pi-pur-1-1'`; // 12 x 60,001 = 720,012
    const r = await check();
    red(r);
    expect(r.purchases.totalMismatches).toEqual([
      {
        purchase: "PUR-2026-000001",
        problems: ["grand total: lines give 900012, header says 900000", "subtotal: lines give 840012, header says 840000", "line 1 total: lines give 720012, header says 720000"],
      },
    ]);
    expect(r.failures).toContain("1 purchase total mismatch(es) (lines vs header)");
    expect(formatReport(r)).toContain("✗ purchase PUR-2026-000001: grand total: lines give 900012, header says 900000");
    expect(r.suppliers.differences).toEqual([]); // the ledger still agrees with the header: a wrong LINE is a different fault
    expect(r.purchaseStock.mismatches).toEqual([]); // stock is untouched: only the totals check can see this
  });

  it("a header freight the lines do not support (the charge is in the total) names that purchase", async () => {
    await sql`UPDATE purchases SET freight_p = freight_p + 1000 WHERE legacy_id = 'pur-1'`;
    const r = await check();
    red(r);
    expect(r.purchases.totalMismatches).toEqual([{ purchase: "PUR-2026-000001", problems: ["grand total: lines give 901000, header says 900000"] }]);
  });

  it("the header's ONE discount figure is split into line + overall discount like the legacy toDraft: a discount the lines do not carry is caught", async () => {
    await sql`UPDATE purchases SET discount_amount_p = 5000 WHERE legacy_id = 'pur-4'`; // no line discount, so the whole 5,000 is an 'overall' discount
    const r = await check();
    red(r);
    expect(r.purchases.totalMismatches).toEqual([{ purchase: "PUR-2026-000004", problems: ["grand total: lines give 95000, header says 100000"] }]); // the split figure (5,000) is the same on both sides; what is off is the total it should have produced
  });

  it("the header's ONE discount figure is split like the legacy toDraft (pur-2: 100,000 = 60,000 on the line + 40,000 overall): moving 10,000 off the line changes the line total and nothing else", async () => {
    await sql`UPDATE purchase_items SET discount_p = 50000 WHERE legacy_id = 'pi-pur-2-1'`; // the overall part is now 50,000, so the grand total and the discount amount still add up
    const r = await check();
    red(r);
    expect(r.purchases.totalMismatches).toEqual([{ purchase: "PUR-2026-000002", problems: ["line 1 total: lines give 450000, header says 440000"] }]);
  });

  it("a quantity / line-count drift is caught", async () => {
    await sql`UPDATE purchases SET total_qty_milli = 14000, line_count = 3 WHERE legacy_id = 'pur-1'`;
    const r = await check();
    red(r);
    expect(r.purchases.totalMismatches).toEqual([{ purchase: "PUR-2026-000001", problems: ["quantity (thousandths): lines give 15000, header says 14000", "line count: lines give 2, header says 3"] }]);
  });

  it("a purchase with no lines in the backup is LISTED, not failed by the totals check (an old backup can have one)", async () => {
    const backup = mutate((b) => { b.data.purchaseItems = b.data.purchaseItems.filter((i: any) => i.purchaseId !== "pur-2"); }); // received 0: nothing to net
    await runImport(backup, IMPORT_OPTS);
    const r = await check(backup);
    expect(r.failures).toEqual([]);
    expect(r.purchases.noLines).toEqual(["PUR-2026-000002"]);
    expect(r.purchases.totalMismatches).toEqual([]);
    expect(r.ok).toBe(true);
    expect(formatReport(r)).toContain("note: no lines on PUR-2026-000002");
  });

  it("…but a purchase that lost the lines its bags arrived on IS failed, by the purchase<->stock check (its movement has no line behind it)", async () => {
    const backup = mutate((b) => { b.data.purchaseItems = b.data.purchaseItems.filter((i: any) => i.purchaseId !== "pur-4"); });
    await runImport(backup, IMPORT_OPTS);
    const r = await check(backup);
    red(r);
    expect(r.purchases.noLines).toEqual(["PUR-2026-000004"]);
    expect(r.purchaseStock.mismatches).toEqual([{ purchase: "PUR-2026-000004", product: "p-3", warehouse: "wh-2", expectedMilli: 0, netMilli: 60_000 }]);
  });

  it("a mismatch on a MIGRATED purchase is informational (its total never came from Calc) but still printed", async () => {
    await sql`UPDATE purchases SET migrated = true WHERE legacy_id = 'pur-4'`;
    await sql`UPDATE purchase_items SET unit_price_p = 1001 WHERE legacy_id = 'pi-pur-4-1'`;
    const r = await check();
    expect(r.purchases.totalMismatches).toEqual([]);
    expect(r.purchases.migrated).toEqual(["PUR-2026-000004"]);
    expect(r.purchases.migratedMismatches.map((m) => m.purchase)).toEqual(["PUR-2026-000004"]);
    expect(formatReport(r)).toContain("· migrated purchase PUR-2026-000004 (informational");
    expect(r.purchaseStock.migratedSkipped).toEqual(["PUR-2026-000004"]);
  });
});

describe("purchase <-> stock: a purchase's movements net to the bags its lines received", () => {
  it("a purchase movement that went missing names the purchase, product and godown with both numbers (the part delivery's 60 bags)", async () => {
    await sql`DELETE FROM stock_movements WHERE ref = 'PUR-2026-000004'`;
    const r = await check();
    red(r);
    expect(r.purchaseStock.mismatches).toEqual([{ purchase: "PUR-2026-000004", product: "p-3", warehouse: "wh-2", expectedMilli: 60_000, netMilli: 0 }]);
    expect(r.failures).toContain("1 purchase/stock mismatch(es) (movements vs purchase lines)");
    expect(formatReport(r)).toContain("✗ purchase PUR-2026-000004, product p-3 @ warehouse wh-2: lines say 60, movements net 0");
    expect(r.stock.mismatches.map((m) => m.product)).toEqual(["p-3"]); // and the stock check sees the level disagree as well
  });

  it("an edit whose reversal went missing (the bags were added twice) is caught", async () => {
    await sql`DELETE FROM stock_movements WHERE legacy_id = 'mv-21'`; // PUR-1's PURCHASE_REVERSAL_OUT of 12 bags of p-1 at wh-1
    const r = await check();
    red(r);
    expect(r.purchaseStock.mismatches).toEqual([{ purchase: "PUR-2026-000001", product: "p-1", warehouse: "wh-1", expectedMilli: 12_000, netMilli: 24_000 }]);
  });

  it("a cancelled purchase whose bags did not come back is caught (expected net 0)", async () => {
    await sql`DELETE FROM stock_movements WHERE ref = 'PUR-2026-000003' AND kind = 'PURCHASE_REVERSAL_OUT'`;
    const r = await check();
    red(r);
    expect(r.purchaseStock.mismatches).toEqual([{ purchase: "PUR-2026-000003", product: "p-2", warehouse: "wh-1", expectedMilli: 0, netMilli: 6000 }]);
  });

  it("a line whose received bags were changed (the bags the bill says arrived no longer match the bags booked) is caught", async () => {
    await sql`UPDATE purchase_items SET received_qty_milli = 50000 WHERE legacy_id = 'pi-pur-4-1'`;
    const r = await check();
    red(r);
    expect(r.purchaseStock.mismatches).toEqual([{ purchase: "PUR-2026-000004", product: "p-3", warehouse: "wh-2", expectedMilli: 50_000, netMilli: 60_000 }]);
  });

  it("a movement booked into the WRONG godown is caught on both godowns", async () => {
    await sql`UPDATE stock_movements SET warehouse_id = (SELECT id FROM warehouses WHERE legacy_id = 'wh-1') WHERE ref = 'PUR-2026-000004'`;
    const r = await check();
    red(r);
    expect(r.purchaseStock.mismatches).toEqual(
      expect.arrayContaining([
        { purchase: "PUR-2026-000004", product: "p-3", warehouse: "wh-2", expectedMilli: 60_000, netMilli: 0 },
        { purchase: "PUR-2026-000004", product: "p-3", warehouse: "wh-1", expectedMilli: 0, netMilli: 60_000 },
      ]),
    );
  });
});

describe("average cost: a stock row is the weighted average of its purchase lines", () => {
  it("a drifted average names the product, godown and both figures", async () => {
    await sql`UPDATE stock_levels SET avg_cost_p = 46000 WHERE product_id = (SELECT id FROM products WHERE legacy_id = 'p-2') AND warehouse_id = (SELECT id FROM warehouses WHERE legacy_id = 'wh-2')`;
    const r = await check();
    red(r);
    expect(r.averageCost.mismatches).toEqual([{ product: "p-2", warehouse: "wh-2", purchaseLines: 1, recomputedP: 45_857, storedP: 46_000 }]);
    expect(r.averageCost.matched).toBe(2);
    expect(r.failures).toContain("1 average cost mismatch(es) (stock row vs purchase lines)");
    expect(formatReport(r)).toContain("✗ product p-2 @ warehouse wh-2: purchase lines (1) give 45,857, stock row says 46,000 paisa");
  });

  it("a CANCELLED purchase is left out of the average: un-cancel pur-3 and p-2 @ wh-1 (kept at 85,000) is recomputed to 50,000 and fails", async () => {
    await sql`UPDATE purchases SET status = 'RECEIVED' WHERE legacy_id = 'pur-3'`;
    const r = await check();
    red(r);
    expect(r.averageCost.mismatches).toEqual([{ product: "p-2", warehouse: "wh-1", purchaseLines: 1, recomputedP: 50_000, storedP: 85_000 }]);
    expect(r.averageCost.keptFromBefore.map((k) => `${k.product}@${k.warehouse}`).sort()).toEqual(["p-1@wh-2", "p-3@wh-1"]);
  });

  it("a line that received nothing does not count: give pur-2's line bags and p-3 @ wh-1 (kept at 0) is recomputed to 44,000 and fails", async () => {
    await sql`UPDATE purchase_items SET received_qty_milli = 10000 WHERE legacy_id = 'pi-pur-2-1'`;
    const r = await check();
    red(r);
    expect(r.averageCost.mismatches).toEqual([{ product: "p-3", warehouse: "wh-1", purchaseLines: 1, recomputedP: 44_000, storedP: 0 }]);
  });

  it("the average is weighted by the bags RECEIVED: a changed received quantity on a two-line row moves it (and the stock check sees the bags)", async () => {
    // a second line for p-1 @ wh-1 on the part-delivery purchase: 10 bags at 100,000 -> average (64,286 x 12 + 100,000 x 10) / 22 = 80,520
    const [p] = await sql`SELECT id FROM purchases WHERE legacy_id = 'pur-4'`;
    const [prod] = await sql`SELECT id FROM products WHERE legacy_id = 'p-1'`;
    const [wh] = await sql`SELECT id FROM warehouses WHERE legacy_id = 'wh-1'`;
    await sql`
      INSERT INTO purchase_items (legacy_id, purchase_id, product_id, warehouse_id, qty_milli, received_qty_milli, unit_price_p, line_total_p, goods_unit_cost_p, charge_share_p, landed_unit_cost_p)
      VALUES ('pi-extra', ${p!.id}, ${prod!.id}, ${wh!.id}, 10000, 10000, 100000, 1000000, 100000, 0, 100000)`;
    const r = await check();
    red(r);
    expect(r.averageCost.mismatches).toEqual([{ product: "p-1", warehouse: "wh-1", purchaseLines: 2, recomputedP: 80_520, storedP: 64_286 }]);
  });

  it("a stock row with NO purchase line behind it is LISTED as kept-from-before, never failed — whatever its average", async () => {
    await sql`UPDATE stock_levels SET avg_cost_p = 1 WHERE product_id = (SELECT id FROM products WHERE legacy_id = 'p-1') AND warehouse_id = (SELECT id FROM warehouses WHERE legacy_id = 'wh-2')`;
    const r = await check();
    expect(r.failures).toEqual([]);
    expect(r.averageCost.keptFromBefore).toContainEqual({ product: "p-1", warehouse: "wh-2", avgCostP: 1 });
    expect(formatReport(r)).toContain("· kept from before: product p-1 @ warehouse wh-2, average 1 paisa");
  });
});

describe("operational share and landed unit: the substitution S12 relies on", () => {
  it("a line's operational share that the landed-cost rows do not support names the line with both figures", async () => {
    await sql`UPDATE purchase_items SET operational_share_p = 8000 WHERE legacy_id = 'pi-pur-1-2'`;
    const r = await check();
    red(r);
    expect(r.averageCost.operationalShare.mismatches).toEqual([{ purchase: "PUR-2026-000001", line: "pi-pur-1-2", storedP: 8000, landedCostRowsP: 9000 }]);
    expect(r.failures).toContain("1 operational share mismatch(es) (purchase line vs landed-cost rows)");
    expect(formatReport(r)).toContain("✗ purchase PUR-2026-000001, line pi-pur-1-2: operational share 8,000, landed-cost rows say 9,000");
  });

  it("the landed-cost rows are read from the BACKUP: cancel lc-1 there and the 9,000 on the line is no longer supported", async () => {
    const backup = mutate((b) => { b.data.landedCosts.find((l: any) => l.id === "lc-1").status = "CANCELLED"; });
    const r = await check(backup);
    red(r);
    expect(r.averageCost.operationalShare.mismatches).toEqual([{ purchase: "PUR-2026-000001", line: "pi-pur-1-2", storedP: 9000, landedCostRowsP: 0 }]);
  });

  it("…and a CANCELLED landed cost that still sits on a line is caught: un-cancel lc-2 and the first line should carry 5,000, not 0", async () => {
    const backup = mutate((b) => { b.data.landedCosts.find((l: any) => l.id === "lc-2").status = "POSTED"; });
    const r = await check(backup);
    red(r);
    expect(r.averageCost.operationalShare.mismatches).toEqual([{ purchase: "PUR-2026-000001", line: "pi-pur-1-1", storedP: 0, landedCostRowsP: 5000 }]);
  });

  it("a landed-cost row whose purchase line is gone is listed as an orphan, not failed (the legacy ignores it too)", async () => {
    const backup = mutate((b) => { b.data.inventoryCostAdjust.push({ ...b.data.inventoryCostAdjust[0], id: "ica-9", purchaseItemId: "pi-gone" }); });
    const r = await check(backup);
    expect(r.failures).toEqual([]);
    expect(r.averageCost.operationalShare.orphanRows).toEqual(["pi-gone"]);
  });

  it("a wrong landed unit names the line (goods 40,000 + charges 2,857 + operational 3,000 = 45,857, not 45,000)", async () => {
    await sql`UPDATE purchase_items SET landed_unit_cost_p = 45000 WHERE legacy_id = 'pi-pur-1-2'`;
    const r = await check();
    red(r);
    expect(r.averageCost.landedUnit.mismatches).toEqual([{ purchase: "PUR-2026-000001", line: "pi-pur-1-2", storedP: 45_000, recomputedP: 45_857 }]);
    expect(r.failures).toContain("1 landed unit cost mismatch(es) (purchase line)");
    expect(r.averageCost.mismatches).toEqual([]); // the average is built from the parts, never from the stored landed unit
  });

  it("a wrong charge share moves the recomputed landed unit AND the average, and both are named", async () => {
    await sql`UPDATE purchase_items SET charge_share_p = 60000 WHERE legacy_id = 'pi-pur-1-1'`; // 60,000 / 12 = 5,000 a bag, not 4,286
    const r = await check();
    red(r);
    expect(r.averageCost.landedUnit.mismatches).toEqual([{ purchase: "PUR-2026-000001", line: "pi-pur-1-1", storedP: 64_286, recomputedP: 65_000 }]);
    expect(r.averageCost.mismatches).toEqual([{ product: "p-1", warehouse: "wh-1", purchaseLines: 1, recomputedP: 65_000, storedP: 64_286 }]);
  });

  it("a line that received nothing is skipped by the landed-unit check (no bags to spread over), not failed", async () => {
    const r = await check();
    expect(r.averageCost.landedUnit.skippedNothingReceived).toBe(1);
    expect(r.ok).toBe(true);
  });
});
