import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PURCHASE_LIST_LABELS, PURCHASE_PAY_LABELS, PURCHASE_PRINT_LABELS } from "@farooq/shared";

/**
 * S13: the purchase list's and the printed purchase's wording is the legacy's, character for character — except the few sentences S13
 * added on purpose (fix 4's "Bags ordered" / Ordered / Received columns, the Tax row), which are named here and must NOT be in the legacy.
 * Runs where the old project is checked out next to this one (or LEGACY_ERP_DIR); skipped in CI.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.LEGACY_ERP_DIR ?? path.resolve(here, "../../../../projectFarooqAndCoTraders/public_html/ERP/erp-upgrade");
const has = existsSync(path.join(dir, "04-documents.js"));
const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
const strings = (v: unknown): string[] => (typeof v === "string" ? (v.trim() ? [v] : []) : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

/** New wording (fix 4 and the tax row): documented in docs/history/S13.md. */
const NEW = new Set(["Bags ordered", "Ordered", "Received", "Tax", "Amount in words", "Payments against this document"]);

describe.skipIf(!has)("the purchase wording is the legacy's", () => {
  it("the print labels are in 04-documents.js (DocModel.purchase) or the standard paper that draws them", () => {
    const src = read("04-documents.js");
    // columns: only their labels are wording (keys and alignments are not)
    const all = strings({ ...PURCHASE_PRINT_LABELS, columns: PURCHASE_PRINT_LABELS.columns.map((c) => c.label) }).filter((s) => !NEW.has(s));
    expect(all.filter((s) => !src.includes(`'${s}'`))).toEqual([]);
    expect(all.length).toBeGreaterThan(25);
  });

  it("the list's page, toolbar and card words are in farooq-co-erp.html (PAGES.purchases, toolbar, applyFilters)", () => {
    const src = read("farooq-co-erp.html");
    expect(strings(PURCHASE_LIST_LABELS).filter((s) => !src.includes(s))).toEqual([]);
    for (const w of Object.values(PURCHASE_PAY_LABELS)) expect(src).toContain(`'${w}'`);
  });

  it("the words S13 added are really new (so they are listed as owner-visible)", () => {
    const src = read("04-documents.js");
    expect(src).not.toContain("'Bags ordered'");
    expect(src).not.toContain("label: 'Ordered'");
  });
});
