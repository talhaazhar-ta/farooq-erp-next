import { afterAll, describe, expect, it } from "vitest";
import { ImportError, WIPED_TABLES, assertLocalDatabaseUrl, runImport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture } from "./helpers.js";

const sql = adminSql();
afterAll(async () => {
  await sql.end();
});

/** Row counts, a fingerprint of the ids, and every party balance — everything an import produces. */
async function fingerprint() {
  const tables = ["regions", "warehouses", "products", "customers", "suppliers", "invoices", "purchases", "payments", "payment_allocations", "returns", "account_adjustments", "milling_jobs", "sequences", "journal_entries", "journal_lines"];
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = Number((await sql.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0]?.n);
  const ids = String(((await sql`
    SELECT md5(string_agg(id::text, ',' ORDER BY id::text)) AS h FROM (
      SELECT id FROM customers UNION ALL SELECT id FROM suppliers UNION ALL SELECT id FROM invoices
      UNION ALL SELECT id FROM payments UNION ALL SELECT id FROM journal_entries) x`)[0] as unknown as { h: string }).h);
  const balances = await sql`
    SELECT COALESCE(c.legacy_id, s.legacy_id) AS party, a.code, SUM(l.debit_p - l.credit_p)::text AS net
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    LEFT JOIN customers c ON c.id = l.party_id LEFT JOIN suppliers s ON s.id = l.party_id
    WHERE l.party_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`;
  return { counts, ids, balances: balances.map((r) => [r.party, r.code, r.net]) };
}

describe("idempotency", () => {
  it("importing the same backup twice gives identical rows, identical ids and identical balances", async () => {
    await runImport(fixture(), IMPORT_OPTS);
    const first = await fingerprint();
    await runImport(fixture(), IMPORT_OPTS);
    const second = await fingerprint();
    expect(second).toEqual(first);
    expect(first.counts.journal_entries).toBe(35); // and it is the full ledger, not an empty one that trivially matches
  });
});

describe("guards", () => {
  it("refuses a database that is not local, before opening any connection", async () => {
    for (const host of ["db.example.com", "10.0.0.5", "31.97.219.57", "srv1234.hstgr.io"]) {
      await expect(runImport(fixture(), { databaseUrl: `postgresql://postgres:x@${host}:5432/farooq_erp` })).rejects.toThrow(
        new RegExp(`database host '${host.replace(/\./g, "\\.")}' is not local`),
      );
    }
    expect(() => assertLocalDatabaseUrl("postgresql://postgres:x@localhost:5432/d")).not.toThrow();
    expect(() => assertLocalDatabaseUrl("postgresql://postgres:x@127.0.0.1:5432/d")).not.toThrow();
    expect(() => assertLocalDatabaseUrl("not a url")).toThrow(ImportError);
  });

  it("never wipes users, sessions, role_permissions, audit_log or the control accounts", async () => {
    // Put a row in each protected table, import (which TRUNCATEs the business tables), and check they all survived.
    const [u] = await sql`
      INSERT INTO users (name, username, password_hash, role) VALUES ('Guard Test', ${`guard-${Date.now()}`}, 'x', 'MANAGER') RETURNING id`;
    await sql`INSERT INTO sessions (user_id, csrf_token, expires_at) VALUES (${u!.id}, 'csrf', now() + interval '1 hour')`;
    await sql`INSERT INTO role_permissions (role, permission) VALUES ('MANAGER', ${`GUARD_TEST_${Date.now()}`})`;
    await sql`INSERT INTO audit_log (action, entity, entity_id) VALUES ('GUARD_TEST', 'guard', 'g')`;
    const protectedCounts = async () =>
      (await sql`
        SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM sessions)::int AS sessions,
               (SELECT count(*) FROM role_permissions)::int AS role_permissions, (SELECT count(*) FROM audit_log)::int AS audit_log,
               (SELECT count(*) FROM accounts)::int AS accounts`)[0];
    const before = await protectedCounts();

    await runImport(fixture(), IMPORT_OPTS);

    const after = await protectedCounts();
    expect(after).toEqual({ ...before, audit_log: before!.audit_log + 1 }); // only the IMPORT audit row was added
    const [guard] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'GUARD_TEST'`;
    expect(guard!.n).toBeGreaterThanOrEqual(1);
    expect(before!.accounts).toBeGreaterThanOrEqual(11);
  });

  it("the wipe list contains none of the protected tables", () => {
    for (const protectedTable of ["users", "sessions", "role_permissions", "audit_log", "accounts"]) {
      expect(WIPED_TABLES as readonly string[]).not.toContain(protectedTable);
    }
  });
});
