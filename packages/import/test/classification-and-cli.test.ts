import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import {
  DEFERRED_STORES,
  FIELD_CLASSES,
  IGNORED_STORES,
  IMPORTED_STORES,
  createLegacyLedger,
  prepareImport,
  VERBATIM_STORES,
  type ImportedStore,
  type VerbatimStore,
} from "../src/index.js";
import { assertClassificationComplete } from "../src/validate.js";
import { FIXTURE_PATH, buildFixture } from "../fixtures/build-fixture.js";
import { fixture, mutate } from "./helpers.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("store / field classification", () => {
  it("every store is in exactly one of imported / deferred / ignored", () => {
    const lists = [IMPORTED_STORES, DEFERRED_STORES, IGNORED_STORES].map((l) => new Set(Object.keys(l)));
    const all = lists.flatMap((s) => [...s]);
    expect(new Set(all).size).toBe(all.length);
    expect(() => assertClassificationComplete()).not.toThrow();
  });

  it("the moved-to-imported stores are the two the legacy Ledger reads: accountAdjustments (16-khata.js) and millingJobs (32-milling.js)", () => {
    expect(Object.keys(IMPORTED_STORES)).toEqual(expect.arrayContaining(["accountAdjustments", "millingJobs"]));
    expect(Object.keys(DEFERRED_STORES)).not.toContain("accountAdjustments");
    expect(Object.keys(DEFERRED_STORES)).not.toContain("millingJobs");
  });

  it("every imported store has a field list — except the verbatim ones, which are exactly the settings bag (`business`)", () => {
    const withFields = new Set(Object.keys(FIELD_CLASSES));
    const imported = Object.keys(IMPORTED_STORES);
    expect(imported.filter((s) => !withFields.has(s))).toEqual([...VERBATIM_STORES]);
    expect([...VERBATIM_STORES]).toEqual(["business"]);
    expect(Object.keys(DEFERRED_STORES)).not.toContain("business");
  });

  it("no field is classified twice within a store", () => {
    for (const store of Object.keys(FIELD_CLASSES) as Exclude<ImportedStore, VerbatimStore>[]) {
      const c = FIELD_CLASSES[store];
      const keys = [...c.mapped, ...c.docOnly.flatMap((g) => g.keys), ...c.ignored.flatMap((g) => g.keys)];
      expect(keys.filter((k, i) => keys.indexOf(k) !== i), store).toEqual([]);
    }
  });

  it("the fixture has every imported-store field the classification calls `mapped` for the ledger-relevant stores", () => {
    const data = fixture().data;
    for (const [store, mustHave] of Object.entries({
      customers: ["openingBalanceP", "openingBalanceDate", "isCashCounter"],
      payments: ["reversedAt", "reverseReason"],
      accountAdjustments: ["reversedAt"],
      millingJobs: ["settle", "issuedValue", "receivedValue", "feeAmount"],
    })) {
      const keys = new Set(data[store]!.flatMap((d) => Object.keys(d)));
      for (const k of mustHave) expect(keys.has(k), `${store}.${k}`).toBe(true);
    }
  });

  it("prepareImport is pure: it does not mutate the backup it is given (the users store stays untouched, unread)", () => {
    const b = fixture();
    const before = JSON.stringify(b);
    prepareImport(b);
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe("the committed fixture", () => {
  it("is exactly what build-fixture.ts generates (no drift), and holds no real data", () => {
    expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(JSON.parse(JSON.stringify(buildFixture())));
  });
});

// The real nightly backup is gitignored business data: this only runs on a machine that has it (never in CI).
const realBackup = path.resolve(pkgDir, "../../data/business-20260922-210002-v505-6a81.json");
describe.skipIf(!existsSync(realBackup))("the real 2026-09-22 nightly backup (local only)", () => {
  it("classifies fully, and its legacy-ledger totals are what STATUS records", () => {
    const backup = JSON.parse(readFileSync(realBackup, "utf8"));
    expect(() => prepareImport(backup)).not.toThrow();
    const L = createLegacyLedger(backup.data);
    expect(L.customerIds).toHaveLength(409);
    expect(L.supplierIds).toHaveLength(35);
  });
});

describe("the CLI (pnpm --filter @farooq/import run import <backup.json>)", () => {
  const run = (file: string, out: string) =>
    spawnSync("pnpm", ["exec", "tsx", "src/cli.ts", file], {
      cwd: pkgDir,
      env: { ...process.env, DATABASE_URL: TEST_ADMIN_URL, RECONCILIATION_DIR: out },
      encoding: "utf8",
      shell: true,
    });

  it("imports the fixture, prints a report with real numbers, writes the JSON report, and exits 0", () => {
    const out = mkdtempSync(path.join(os.tmpdir(), "farooq-recon-"));
    const r = run(FIXTURE_PATH, out);
    expect(r.stderr).not.toMatch(/IMPORT ABORTED/);
    expect(r.stdout).toContain("Customers   6 compared, 0 balance difference(s)");
    expect(r.stdout).toContain("Suppliers   5 compared, 0 balance difference(s)");
    expect(r.stdout).toContain("Trial balance  35 entries, 70 lines: debit 9,305,000 / credit 9,305,000 paisa — BALANCED");
    expect(r.stdout).toContain("RESULT: PASS — 0 differences");
    expect(r.status).toBe(0);
    const files = readdirSync(out).filter((f) => f.startsWith("reconciliation-"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(out, files[0]!), "utf8")).report.ok).toBe(true);
  });

  it("aborts with a non-zero exit and names the store when the backup has an unknown store", () => {
    const out = mkdtempSync(path.join(os.tmpdir(), "farooq-recon-"));
    const bad = path.join(out, "bad-backup.json");
    writeFileSync(bad, JSON.stringify(mutate((b) => { b.data.gadgets = [{ id: "g1" }]; })));
    const r = run(bad, out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("IMPORT ABORTED");
    expect(r.stderr).toContain("Unknown store 'gadgets'");
  });
});
