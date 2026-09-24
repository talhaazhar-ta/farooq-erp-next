import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacyLedger, runImport, uuidV5, type Backup, type LedgerRow } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { statementSchema, type Statement } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";

/**
 * THE STATEMENT PROOF (S4): for EVERY customer and supplier, `GET /customers|suppliers/:id/statement` — built from the
 * journal — agrees with `LegacyLedger` (S2's independent port of the old algorithm, run on the raw backup JSON with no
 * database) on
 *   - the closing balance, and the multiset of rows (date, kind, number, description, signed amount),
 *   - both for the FULL range and for a mid-range from / to (rows inside the window; closing through `to`),
 *   - and the running balances telescope: opening + Σ rows = closing, each row's balance = the previous + its signed amount.
 * Datasets: the committed synthetic fixture (every ledger branch) and the real nightly backup when present locally.
 * Row ORDER inside one day is deliberately not compared (decision 1: it differs from the legacy by design); the
 * order rules have their own tests in statements-rules.test.ts.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "../../../packages/import/fixtures/synthetic-backup.json");
const REAL = path.join(here, "../../../data/business-20260922-210002-v505-6a81.json");

const rowKey = (date: string, kind: string, ref: string, description: string, signed: number) => `${date}|${kind}|${ref}|${description}|${signed}`;

function defineProof(name: string, backup: Backup): void {
  describe(`statement proof — ${name}`, () => {
    let h: Harness;
    let owner: Session;
    const legacy = createLegacyLedger(backup.data);

    beforeAll(async () => {
      await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: `statements-${name}` });
      h = await createHarness();
      owner = await h.session("OWNER");
    });
    afterAll(async () => {
      await h.close();
    });

    const fetchStatement = async (type: "customers" | "suppliers", legacyId: string, from?: string, to?: string): Promise<Statement> => {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      const res = await h.request(owner, "GET", `/${type}/${uuidV5(`${type}:${legacyId}`)}/statement?${q}`);
      expect(res.status, `${type} ${legacyId}: ${JSON.stringify(res.body)}`).toBe(200);
      return statementSchema.parse(res.body);
    };

    /** signed = the balance movement of a row, on either side. */
    const signedLegacy = (type: "customers" | "suppliers", r: LedgerRow) => (type === "customers" ? r.dr - r.cr : r.cr - r.dr);
    const signedNew = (type: "customers" | "suppliers", r: { debitP: number; creditP: number }) => (type === "customers" ? r.debitP - r.creditP : r.creditP - r.debitP);

    function compare(type: "customers" | "suppliers", legacyId: string, s: Statement, from?: string, to?: string): string[] {
      const errors: string[] = [];
      const L = type === "customers" ? legacy.customer(legacyId, from, to) : legacy.supplier(legacyId, from, to);
      const want = L.rows.map((r) => rowKey(r.iso, r.kind, r.ref ?? "", r.what, signedLegacy(type, r))).sort();
      const got = s.rows.map((r) => rowKey(r.date, r.kind, r.ref, r.description, signedNew(type, r))).sort();
      if (JSON.stringify(want) !== JSON.stringify(got)) errors.push(`${type} ${legacyId} [${from ?? ""}..${to ?? ""}]: rows differ\n  legacy ${want.join(" ; ")}\n  new    ${got.join(" ; ")}`);
      if (s.closing !== L.closing) errors.push(`${type} ${legacyId} [${from ?? ""}..${to ?? ""}]: closing ${s.closing} != legacy ${L.closing}`);
      if (!from && s.opening !== 0) errors.push(`${type} ${legacyId}: opening ${s.opening} but there is no from`);
      // the totals are Σ debit / Σ credit of the rows shown (the legacy's `debit` / `credit`)
      const dr = s.rows.reduce((a, r) => a + r.debitP, 0);
      const cr = s.rows.reduce((a, r) => a + r.creditP, 0);
      if (s.totals.debitP !== dr || s.totals.creditP !== cr) errors.push(`${type} ${legacyId}: totals are not the sum of the rows`);
      // running balances telescope
      let running = s.opening;
      for (const r of s.rows) {
        running += signedNew(type, r);
        if (r.balanceP !== running) {
          errors.push(`${type} ${legacyId}: running balance breaks at ${r.date} ${r.ref} (${r.balanceP} != ${running})`);
          break;
        }
      }
      if (running !== s.closing) errors.push(`${type} ${legacyId}: opening + Σ rows (${running}) != closing (${s.closing})`);
      return errors;
    }

    /** a window that cuts the party's history in the middle: from the 1/3 date to the 2/3 date of its own rows */
    function midRange(type: "customers" | "suppliers", legacyId: string): { from: string; to: string } | null {
      const all = (type === "customers" ? legacy.customer(legacyId) : legacy.supplier(legacyId)).rows.map((r) => r.iso).sort();
      const dates = [...new Set(all)];
      if (dates.length < 3) return null;
      return { from: dates[Math.floor(dates.length / 3)]!, to: dates[Math.floor((dates.length * 2) / 3)]! };
    }

    it("every customer: closing balance, rows, totals and running balances agree with the legacy — full range and a mid-range window", async () => {
      const failures: string[] = [];
      let windowed = 0;
      let withRows = 0;
      for (const id of legacy.customerIds) {
        const full = await fetchStatement("customers", id);
        if (full.rows.length) withRows++;
        failures.push(...compare("customers", id, full));
        const w = midRange("customers", id);
        if (w) {
          windowed++;
          failures.push(...compare("customers", id, await fetchStatement("customers", id, w.from, w.to), w.from, w.to));
          failures.push(...compare("customers", id, await fetchStatement("customers", id, w.from), w.from)); // from only
          failures.push(...compare("customers", id, await fetchStatement("customers", id, undefined, w.to), undefined, w.to)); // to only
        }
      }
      expect(failures).toEqual([]);
      expect(withRows).toBeGreaterThan(0);
      if (name === "fixture") expect(windowed).toBeGreaterThanOrEqual(3); // the fixture's busy shops really are windowed
    }, 180_000);

    it("every supplier: the same", async () => {
      const failures: string[] = [];
      for (const id of legacy.supplierIds) {
        failures.push(...compare("suppliers", id, await fetchStatement("suppliers", id)));
        const w = midRange("suppliers", id);
        if (w) {
          failures.push(...compare("suppliers", id, await fetchStatement("suppliers", id, w.from, w.to), w.from, w.to));
          failures.push(...compare("suppliers", id, await fetchStatement("suppliers", id, undefined, w.to), undefined, w.to));
        }
      }
      expect(failures).toEqual([]);
    }, 180_000);

    it("the closing balance of every party equals the party balance endpoint (both read the same journal)", async () => {
      for (const id of [...legacy.customerIds.slice(0, 25)]) {
        const s = await fetchStatement("customers", id);
        const b = await h.request(owner, "GET", `/customers/${uuidV5(`customers:${id}`)}/balance`);
        expect(s.closing, id).toBe(b.body.balanceP);
      }
      for (const id of legacy.supplierIds.slice(0, 25)) {
        const s = await fetchStatement("suppliers", id);
        const b = await h.request(owner, "GET", `/suppliers/${uuidV5(`suppliers:${id}`)}/balance`);
        expect(s.closing, id).toBe(b.body.balanceP);
      }
    });
  });
}

defineProof("fixture", JSON.parse(readFileSync(FIXTURE, "utf8")) as Backup);
if (existsSync(REAL)) defineProof("real nightly backup (local only)", JSON.parse(readFileSync(REAL, "utf8")) as Backup);
