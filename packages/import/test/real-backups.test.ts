import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { checkEnvelope, exitCodeFor, formatReport, reconcile, runImport } from "../src/index.js";
import { IMPORT_OPTS } from "./helpers.js";

/**
 * The definition of "correct" (CLAUDE.md rule 8) on REAL nightly backups: balances, invoice totals, stock and
 * invoice<->stock all reconcile with 0 differences. The backups are business data (gitignored, under /data/), so this
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
    it(`${file}: import + reconcile — 0 balance, invoice-total, stock and invoice/stock differences`, async () => {
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
    });
  }
});
