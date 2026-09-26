import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { exitCodeFor, formatReport, reconcile, runImport, type ReconciliationReport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * "Every new check must be shown to bite": a green S6 reconciliation only means something if damaging the data turns it
 * red and NAMES what is wrong. Each test imports the fixture fresh, proves it is green, damages one thing directly in
 * the database (as the admin role), and asserts the report names exactly that invoice / product and exits non-zero.
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

const check = () => reconcile(fixture(), TEST_ADMIN_URL);
const red = (r: ReconciliationReport) => {
  expect(r.ok).toBe(false);
  expect(exitCodeFor(r)).toBe(1);
  expect(formatReport(r)).toContain("RESULT: FAIL");
};

describe("invoice totals: lines vs header", () => {
  it("a changed line price names exactly that invoice (grand total, subtotal and that line's total all disagree)", async () => {
    await sql`UPDATE invoice_items SET unit_price_p = 100001 WHERE legacy_id = 'ii-inv-1-1'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches).toEqual([
      {
        invoice: "INV-2026-000001",
        problems: ["grand total: lines give 1000010, header says 1000000", "subtotal: lines give 1000010, header says 1000000", "line 1 total: lines give 1000010, header says 1000000"],
      },
    ]);
    expect(r.failures).toContain("1 invoice total mismatch(es) (lines vs header)");
    expect(formatReport(r)).toContain("✗ invoice INV-2026-000001: grand total: lines give 1000010, header says 1000000");
    expect(r.stock.mismatches).toEqual([]); // stock is untouched: only the totals check can see this
    expect(r.customers.differences).toEqual([]); // and the ledger still agrees with the header: a wrong LINE is a different fault
  });

  it("a header discount that the lines do not support names that invoice (the rich one, inv-5)", async () => {
    await sql`UPDATE invoices SET invoice_discount_p = invoice_discount_p + 1000 WHERE legacy_id = 'inv-5'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches.map((m) => m.invoice)).toEqual(["INV-2026-000004"]);
    expect(r.invoices.totalMismatches[0]!.problems).toEqual(expect.arrayContaining(["grand total: lines give 299000, header says 300000"]));
  });

  it("a line whose tax was dropped is caught (inv-5's taxed line): the tax, the grand total and the line total disagree", async () => {
    await sql`UPDATE invoice_items SET tax_p = 0 WHERE legacy_id = 'ii-inv-5-2'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches).toEqual([
      {
        invoice: "INV-2026-000004",
        problems: ["grand total: lines give 295000, header says 300000", "tax: lines give 0, header says 5000", "line 2 total: lines give 100000, header says 105000"],
      },
    ]);
  });

  it("a wrong stored line total (the line's own arithmetic) is caught even when the header still adds up", async () => {
    await sql`UPDATE invoice_items SET line_total_p = line_total_p - 1 WHERE legacy_id = 'ii-inv-2-2'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches).toEqual([{ invoice: "INV-2026-000002", problems: ["line 2 total: lines give 140000, header says 139999"] }]);
  });

  it("a wrong stored quantity total or line count is caught", async () => {
    await sql`UPDATE invoices SET total_qty_milli = total_qty_milli + 1, line_count = 3 WHERE legacy_id = 'inv-6'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches).toEqual([
      { invoice: "INV-2026-000005", problems: ["quantity (thousandths): lines give 2500, header says 2501", "line count: lines give 1, header says 3"] },
    ]);
  });

  it("the legacy discountAmount kept in the document must equal item + invoice discounts", async () => {
    await sql`UPDATE invoices SET legacy_doc = jsonb_set(legacy_doc, '{discountAmount}', '125001') WHERE legacy_id = 'inv-5'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches).toEqual([{ invoice: "INV-2026-000004", problems: ["legacy discountAmount: lines give 125000, header says 125001"] }]);
  });

  it("a CANCELLED invoice is checked too (a cancelled invoice keeps its lines and total)", async () => {
    await sql`UPDATE invoice_items SET qty_milli = 3000 WHERE legacy_id = 'ii-inv-4-1'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches.map((m) => m.invoice)).toEqual(["INV-2026-000003"]);
  });

  it("a DRAFT is not checked (it is not in the ledger and its lines may be mid-edit)", async () => {
    await sql`UPDATE invoice_items SET unit_price_p = 1 WHERE legacy_id = 'ii-inv-3-1'`;
    const r = await check();
    expect(r.ok).toBe(true);
    expect(r.invoices.drafts).toBe(1);
  });

  it("a migrated invoice that has no lines in the backup is LISTED, not failed (the old migration could make one; nothing was ever taken for it)", async () => {
    const backup = mutate((b) => { b.data.invoiceItems = b.data.invoiceItems.filter((i: any) => i.invoiceId !== "inv-7"); });
    await runImport(backup, IMPORT_OPTS);
    const r = await reconcile(backup, TEST_ADMIN_URL);
    expect(r.failures).toEqual([]);
    expect(r.invoices.noLines).toEqual(["INV-2026-000006"]);
    expect(r.invoices.totalMismatches).toEqual([]);
    expect(r.ok).toBe(true);
    expect(formatReport(r)).toContain("note: no lines on INV-2026-000006");
  });

  it("…but a normal posted invoice that lost its lines IS failed, by the invoice<->stock check (its stock is still out)", async () => {
    await sql`DELETE FROM invoice_items WHERE legacy_id = 'ii-inv-1-1'`;
    const r = await check();
    red(r);
    expect(r.invoices.noLines).toEqual(["INV-2026-000001"]);
    expect(r.invoiceStock.mismatches).toEqual([{ invoice: "INV-2026-000001", product: "p-1", expectedMilli: 0, netMilli: -10_000 }]);
  });

  it("a mismatch on a MIGRATED invoice is informational (its total never came from Calc) but still printed", async () => {
    await sql`UPDATE invoice_items SET unit_price_p = 80001 WHERE legacy_id = 'ii-inv-7-1'`;
    const r = await check();
    expect(r.ok).toBe(true);
    expect(r.invoices.totalMismatches).toEqual([]);
    expect(r.invoices.migratedMismatches.map((m) => m.invoice)).toEqual(["INV-2026-000006"]);
    expect(formatReport(r)).toContain("· migrated invoice INV-2026-000006 (informational");
  });
});

describe("stock: legacy inventory = stock level = sum of movements", () => {
  it("a stock level that drifted names the product, warehouse and bucket, with all three numbers", async () => {
    await sql`UPDATE stock_levels SET qty_milli = qty_milli + 1000 WHERE product_id = (SELECT id FROM products WHERE legacy_id = 'p-2') AND warehouse_id = (SELECT id FROM warehouses WHERE legacy_id = 'wh-1')`;
    const r = await check();
    red(r);
    expect(r.stock.mismatches).toEqual([{ product: "p-2", warehouse: "wh-1", bucket: "stock", legacyMilli: 52_000, levelMilli: 53_000, movementsMilli: 52_000 }]);
    expect(formatReport(r)).toContain("✗ product p-2 @ warehouse wh-1 [stock]: legacy 52, level 53, Σ movements 52");
    expect(r.failures).toContain("1 stock quantity mismatch(es) (inventory vs stock levels vs movements)");
  });

  it("a movement whose quantity was changed breaks both the stock check and (being an invoice movement) the invoice<->stock check", async () => {
    await sql`UPDATE stock_movements SET qty_delta_milli = -9000 WHERE legacy_id = 'mv-5'`; // inv-1's sale of 10 bags
    const r = await check();
    red(r);
    expect(r.stock.mismatches).toEqual([{ product: "p-1", warehouse: "wh-1", bucket: "stock", legacyMilli: 90_500, levelMilli: 90_500, movementsMilli: 91_500 }]);
    expect(r.invoiceStock.mismatches).toEqual([{ invoice: "INV-2026-000001", product: "p-1", expectedMilli: -10_000, netMilli: -9000 }]);
  });

  it("a stray movement nobody accounted for (a product's level no longer equals its movements)", async () => {
    await sql`
      INSERT INTO stock_movements (date, product_id, warehouse_id, kind, qty_delta_milli)
      SELECT '2026-03-01', p.id, w.id, 'ADJUSTMENT_IN', 5000 FROM products p, warehouses w WHERE p.legacy_id = 'p-3' AND w.legacy_id = 'wh-1'`;
    const r = await check();
    red(r);
    expect(r.stock.mismatches).toEqual([{ product: "p-3", warehouse: "wh-1", bucket: "stock", legacyMilli: 38_000, levelMilli: 38_000, movementsMilli: 43_000 }]);
    expect(r.invoiceStock.mismatches).toEqual([]); // not an invoice movement
    expect(r.counts.find((c) => c.store === "stockMovements")).toMatchObject({ backup: 32, loaded: 33, match: false }); // and the row count no longer matches
  });

  it("the damaged bucket is checked separately from the sellable one", async () => {
    await sql`UPDATE stock_levels SET qty_milli = 0 WHERE bucket = 'damaged'`;
    const r = await check();
    red(r);
    expect(r.stock.mismatches).toEqual([{ product: "p-1", warehouse: "wh-1", bucket: "damaged", legacyMilli: 600, levelMilli: 0, movementsMilli: 600 }]);
  });

  it("a missing stock level row is a mismatch (legacy 38 bags, level 0), and the store count fails too", async () => {
    await sql`DELETE FROM stock_levels WHERE product_id = (SELECT id FROM products WHERE legacy_id = 'p-3') AND warehouse_id = (SELECT id FROM warehouses WHERE legacy_id = 'wh-1')`;
    const r = await check();
    red(r);
    expect(r.stock.mismatches).toEqual([{ product: "p-3", warehouse: "wh-1", bucket: "stock", legacyMilli: 38_000, levelMilli: 0, movementsMilli: 38_000 }]);
    expect(r.counts.find((c) => c.store === "inventory")).toMatchObject({ backup: 6, loaded: 5, match: false });
  });

  it("a level that agrees with the movements but NOT with the legacy inventory is caught (the legacy figure is the third witness)", async () => {
    // move the level and a movement together, so level = sum of movements; only the legacy inventory row disagrees
    await sql`UPDATE stock_levels SET qty_milli = qty_milli + 500 WHERE product_id = (SELECT id FROM products WHERE legacy_id = 'p-3') AND warehouse_id = (SELECT id FROM warehouses WHERE legacy_id = 'wh-1')`;
    await sql`UPDATE stock_movements SET qty_delta_milli = qty_delta_milli + 500 WHERE legacy_id = 'mv-3'`;
    const r = await check();
    red(r);
    expect(r.stock.mismatches).toEqual([{ product: "p-3", warehouse: "wh-1", bucket: "stock", legacyMilli: 38_000, levelMilli: 38_500, movementsMilli: 38_500 }]);
  });
});

describe("invoice <-> stock: a posted invoice's movements net to minus its lines", () => {
  it("a movement re-pointed at another invoice leaves the levels intact but names BOTH invoices", async () => {
    await sql`UPDATE stock_movements SET source_id = (SELECT id FROM invoices WHERE legacy_id = 'inv-6') WHERE legacy_id = 'mv-5'`; // inv-1's -10 bags now says inv-6
    const r = await check();
    red(r);
    expect(r.stock.mismatches).toEqual([]);
    expect(r.invoiceStock.mismatches).toEqual(
      expect.arrayContaining([
        { invoice: "INV-2026-000001", product: "p-1", expectedMilli: -10_000, netMilli: 0 },
        { invoice: "INV-2026-000005", product: "p-1", expectedMilli: -2500, netMilli: -12_500 },
      ]),
    );
    expect(r.invoiceStock.mismatches).toHaveLength(2);
  });

  it("an edit whose reversal went missing (the stock was deducted twice) is caught", async () => {
    await sql`DELETE FROM stock_movements WHERE legacy_id = 'mv-8'`; // inv-2's SALE_REVERSAL_IN of 4 bags of p-2
    const r = await check();
    red(r);
    expect(r.invoiceStock.mismatches).toEqual([{ invoice: "INV-2026-000002", product: "p-2", expectedMilli: -4000, netMilli: -8000 }]);
    expect(r.stock.mismatches.map((m) => m.product)).toEqual(["p-2"]); // and the level no longer matches either
  });

  it("a cancelled invoice whose bags did not come back is caught (expected net 0)", async () => {
    await sql`DELETE FROM stock_movements WHERE legacy_id = 'mv-13'`; // inv-4's INVOICE_CANCEL reversal
    const r = await check();
    red(r);
    expect(r.invoiceStock.mismatches).toEqual([{ invoice: "INV-2026-000003", product: "p-2", expectedMilli: 0, netMilli: -2000 }]);
  });

  it("an invoice flagged as holding no stock while its sale is still booked is caught", async () => {
    await sql`UPDATE invoices SET stock_applied = false WHERE legacy_id = 'inv-1'`;
    const r = await check();
    red(r);
    expect(r.invoiceStock.mismatches).toEqual([{ invoice: "INV-2026-000001", product: "p-1", expectedMilli: 0, netMilli: -10_000 }]);
  });

  it("a line whose quantity was changed (the bags sold no longer match the bags taken) is caught by BOTH totals and stock", async () => {
    await sql`UPDATE invoice_items SET qty_milli = 9000 WHERE legacy_id = 'ii-inv-1-1'`;
    const r = await check();
    red(r);
    expect(r.invoices.totalMismatches.map((m) => m.invoice)).toEqual(["INV-2026-000001"]);
    expect(r.invoiceStock.mismatches).toEqual([{ invoice: "INV-2026-000001", product: "p-1", expectedMilli: -9000, netMilli: -10_000 }]);
  });

  it("the migrated invoice is skipped, not failed: it holds stock (stock_applied) with no movement, by design", async () => {
    const r = await check();
    expect(r.invoiceStock.migratedSkipped).toBe(1);
    expect(r.invoiceStock.mismatches).toEqual([]);
  });
});
