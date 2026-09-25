import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { checkEnvelope, exitCodeFor, formatReport, reconcile, runImport } from "../src/index.js";
import { IMPORT_OPTS } from "./helpers.js";

/**
 * The definition of "correct" (CLAUDE.md rule 8) on REAL nightly backups: balances, invoice totals, stock,
 * invoice<->stock and (S11) purchase totals, purchase<->stock, average cost and the landed-cost shares all reconcile with 0 differences. The backups are business data (gitignored, under /data/), so this
 * runs only where they exist — never in CI. It prints counts and totals only, never a row.
 *
 * The two newest `business-*.json` nightlies are used (file names sort by date).
 */
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
const files = existsSync(dataDir)
  ? readdirSync(dataDir)
      .filter((f) => /^business-.*\.json$/.test(f))
      .sort()
      .slice(-2)
  : [];

describe.skipIf(files.length === 0)("real nightly backups (local only)", () => {
  for (const file of files) {
    it(`${file}: import + reconcile — 0 balance, invoice-total, stock, invoice/stock, purchase-total, purchase/stock, average-cost and landed-cost differences`, async () => {
      const backup = checkEnvelope(JSON.parse(readFileSync(path.join(dataDir, file), "utf8")));
      const result = await runImport(backup, IMPORT_OPTS);
      const report = await reconcile(backup, TEST_ADMIN_URL);
      console.log(`\n=== ${file} ===\nmigrated invoices: ${result.migratedInvoices.length}; warnings: ${result.warnings.length}\n${formatReport(report)}`);
      expect(report.failures).toEqual([]);
      expect(exitCodeFor(report)).toBe(0);
      expect(report.customers.differences).toEqual([]);
      expect(report.suppliers.differences).toEqual([]);
      expect(report.invoices.totalMismatches).toEqual([]);
      expect(report.stock.mismatches).toEqual([]);
      expect(report.invoiceStock.mismatches).toEqual([]);
      // S11: purchases
      expect(report.purchases.totalMismatches).toEqual([]);
      expect(report.purchases.migratedMismatches).toEqual([]);
      expect(report.purchaseStock.mismatches).toEqual([]);
      const cost = report.averageCost;
      expect(cost.mismatches).toEqual([]);
      expect(cost.matched).toBe(cost.rows); // every stock row with a purchase line behind it is recomputed exactly; the rest are listed (kept from before)
      expect(cost.operationalShare.mismatches).toEqual([]);
      expect(cost.landedUnit.mismatches).toEqual([]);
      // fix 3 (part delivery) changes no real figure: the allocation recomputed from the lines is what the legacy stored
      expect(cost.allocation.differs).toEqual([]);
      console.log(`average cost (${cost.basis} basis): matched ${cost.matched}, kept from before ${cost.keptFromBefore.length}, mismatched ${cost.mismatches.length}`);
    });
  }
});

/** The first real landed cost (S11): the 2026-09-24 nightly (v710) carries one POSTED landed-cost entry, spread over one purchase line. */
describe.skipIf(!files.some((f) => /v710/.test(f)))("the first real landed cost (v710, local only)", () => {
  it("5 purchases / 6 lines reconcile; the line carrying the landed cost holds exactly the landed-cost rows' share, 6 stock rows match, the 7th average is kept from before", async () => {
    const file = files.find((f) => /v710/.test(f))!;
    const backup = checkEnvelope(JSON.parse(readFileSync(path.join(dataDir, file), "utf8")));
    await runImport(backup, IMPORT_OPTS);
    const report = await reconcile(backup, TEST_ADMIN_URL);
    expect(report.purchases).toMatchObject({ checked: 5, lines: 6, cancelled: 0, migrated: [], noLines: [], totalMismatches: [] });
    expect(report.purchaseStock).toMatchObject({ purchasesChecked: 5, movementsChecked: 14, mismatches: [] });
    expect(report.averageCost.basis).toBe("LANDED");
    expect(report.averageCost).toMatchObject({ rows: 6, matched: 6, mismatches: [] });
    expect(report.averageCost.operationalShare).toMatchObject({ linesChecked: 6, withShare: 1, mismatches: [] });
    expect(report.averageCost.landedUnit).toMatchObject({ linesChecked: 6, mismatches: [] });
    expect(report.averageCost.keptFromBefore.filter((k) => k.avgCostP > 0)).toHaveLength(1); // the 540,000-paisa row with no purchase line left
  });
});
