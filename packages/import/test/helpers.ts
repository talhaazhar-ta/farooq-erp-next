import { readFileSync } from "node:fs";
import postgres from "postgres";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { FIXTURE_PATH } from "../fixtures/build-fixture.js";
import type { Backup } from "../src/index.js";


export const IMPORT_OPTS = { databaseUrl: TEST_ADMIN_URL, sourceName: "test" };

/** A fresh deep copy of the committed synthetic fixture. */
export function fixture(): Backup {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

/** A mutated copy of the fixture; `counts` is recomputed unless the mutation is about counts. */
export function mutate(fn: (b: any) => void, opts: { recount?: boolean } = {}): Backup {
  const b: any = fixture();
  fn(b);
  if (opts.recount !== false) {
    for (const [store, docs] of Object.entries<any[]>(b.data)) b.counts[store] = docs.length;
  }
  return b;
}

export function adminSql() {
  return postgres(TEST_ADMIN_URL, { max: 1, onnotice: () => undefined });
}

/** Balance of one party by legacy id, straight from the journal (customers: debit - credit; suppliers: credit - debit). */
export async function journalBalance(sql: ReturnType<typeof adminSql>, kind: "customers" | "suppliers", legacyId: string): Promise<number> {
  const table = kind;
  const account = kind === "customers" ? "RECEIVABLES" : "PAYABLES";
  const rows = await sql.unsafe(
    `SELECT COALESCE(SUM(l.debit_p), 0)::text AS d, COALESCE(SUM(l.credit_p), 0)::text AS c
     FROM ${table} p
     LEFT JOIN journal_lines l ON l.party_id = p.id AND l.account_id = (SELECT id FROM accounts WHERE code = '${account}')
     WHERE p.legacy_id = $1`,
    [legacyId],
  );
  const d = Number(rows[0]?.d);
  const c = Number(rows[0]?.c);
  return kind === "customers" ? d - c : c - d;
}
