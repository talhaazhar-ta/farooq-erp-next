import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLASSIC_LABELS,
  INVOICE_PRINT_LABELS,
  INVOICE_SEARCH_PROBLEMS,
  INVOICE_SEARCH_SCOPE_LABELS,
  INVOICE_SORT_LABELS,
  INVOICE_STATUS_LABELS,
} from "@farooq/shared";
import { INVOICE_CSV_HEADER } from "../src/invoices/invoices.csv.js";

/**
 * "Labels and Urdu strings verbatim from the legacy files": every label the print model, the list and the CSV carry must occur, character
 * for character, in the legacy source it was taken from. Runs where the old project is checked out next to this one (or LEGACY_ERP_DIR
 * points at its `erp-upgrade` folder) — skipped in CI, where it is not.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.LEGACY_ERP_DIR ?? path.resolve(here, "../../../../projectFarooqAndCoTraders/public_html/ERP/erp-upgrade");
const has = existsSync(path.join(dir, "04-documents.js"));
const read = (f: string) => readFileSync(path.join(dir, f), "utf8");

/** Every non-empty string inside a (nested) constant. */
const strings = (v: unknown): string[] => (typeof v === "string" ? (v.trim() ? [v] : []) : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

describe.skipIf(!has)("the wording is the legacy's, character for character", () => {
  it("the standard invoice labels are in 04-documents.js (or the classic layout that draws them)", () => {
    const src = read("04-documents.js") + read("08-classic-invoice.js");
    const missing = strings(INVOICE_PRINT_LABELS).filter((s) => !src.includes(s) && !src.includes(s.trim()));
    expect(missing).toEqual([]);
  });

  it("the classic layout's labels, headers and Urdu strings are in 08-classic-invoice.js", () => {
    const src = read("08-classic-invoice.js");
    const missing = strings(CLASSIC_LABELS).filter((s) => !src.includes(s) && !src.includes(s.trim()));
    expect(missing).toEqual([]);
    expect(strings(CLASSIC_LABELS).length).toBeGreaterThan(25); // the check did look at them
  });

  it("the status words are ERP.STATUS_LABEL (02-services.js) and the search scopes / sorts / problems are 33-invoice-search.js", () => {
    const services = read("02-services.js");
    for (const [key, label] of Object.entries(INVOICE_STATUS_LABELS)) expect(services, key).toContain(`${key}: '${label}'`);
    const search = read("33-invoice-search.js");
    // `['all',      'Everything']` — the legacy pads its tables with spaces
    const legacyPairs = [...search.matchAll(/\[\s*'(\w+)',\s+'([^']*)'\s*\]/g)].map((m) => [m[1], m[2]]);
    for (const [key, label] of [...Object.entries(INVOICE_SEARCH_SCOPE_LABELS), ...Object.entries(INVOICE_SORT_LABELS)]) {
      expect(legacyPairs, key).toContainEqual([key, label]);
    }
    for (const message of Object.values(INVOICE_SEARCH_PROBLEMS)) expect(search).toContain(message);
  });

  it("the CSV header is the list's own (05-ui-builder.js), in order, and so is the file name", () => {
    const ui = read("05-ui-builder.js");
    const at = ui.indexOf("LIST.exportCsv");
    const legacy = /var rows = \[\[([\s\S]*?)\]\];/.exec(ui.slice(at))![1]!;
    expect([...legacy.matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([...INVOICE_CSV_HEADER]);
    expect(ui).toContain("'farooq-co-invoices-'");
  });
});
