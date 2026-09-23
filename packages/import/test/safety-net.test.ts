import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { exitCodeFor, reconcile, runImport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture } from "./helpers.js";

/**
 * "The safety net must be shown to bite": a green reconciliation only means something if tampering with the
 * ledger turns it red. Each test imports the fixture fresh, damages the journal directly, and asserts the
 * report names exactly the damaged party and the exit code goes non-zero.
 */
const sql = adminSql();

beforeEach(async () => {
  await runImport(fixture(), IMPORT_OPTS);
  expect((await reconcile(fixture(), TEST_ADMIN_URL)).ok).toBe(true); // green before we break it
});
afterAll(async () => {
  await sql.end();
});

const entryId = async (sourceType: string, legacyTable: string, legacyId: string): Promise<string> => {
  const rows = await sql.unsafe(
    `SELECT e.id FROM ${legacyTable} d JOIN journal_entries e ON e.source_id = d.id AND e.source_type = $1 WHERE d.legacy_id = $2`,
    [sourceType, legacyId],
  );
  return rows[0]!.id as string;
};

describe("reconciliation catches a corrupted ledger", () => {
  it("a changed amount (entry kept balanced, so only reconciliation can see it) names exactly that shop", async () => {
    const id = await entryId("INVOICE", "invoices", "inv-1"); // cust-1's first invoice
    await sql.begin(async (tx) => {
      // bump BOTH lines so the deferred balance trigger is satisfied and the trial balance stays balanced
      await tx`UPDATE journal_lines SET debit_p = debit_p + 1000 WHERE entry_id = ${id} AND debit_p > 0`;
      await tx`UPDATE journal_lines SET credit_p = credit_p + 1000 WHERE entry_id = ${id} AND credit_p > 0`;
    });

    const report = await reconcile(fixture(), TEST_ADMIN_URL);
    expect(report.ok).toBe(false);
    expect(exitCodeFor(report)).toBe(1);
    expect(report.customers.differences).toEqual([
      { store: "customers", legacyId: "cust-1", legacyBalanceP: 1_900_000, newBalanceP: 1_901_000, diffP: 1_000 },
    ]);
    expect(report.suppliers.differences).toEqual([]);
    expect(report.trialBalance.balanced).toBe(true); // proves the balance check alone would NOT have caught it
    expect(report.statements.mismatches.map((m) => m.legacyId)).toEqual(["cust-1"]);
    expect(report.failures).toContain("1 customer balance difference(s)");
  });

  it("a missing entry names exactly that supplier", async () => {
    const id = await entryId("PAYMENT", "payments", "pay-4"); // sup-1's 250,000 payment
    await sql.begin(async (tx) => {
      await tx`DELETE FROM journal_lines WHERE entry_id = ${id}`;
      await tx`DELETE FROM journal_entries WHERE id = ${id}`;
    });

    const report = await reconcile(fixture(), TEST_ADMIN_URL);
    expect(report.ok).toBe(false);
    expect(exitCodeFor(report)).toBe(1);
    expect(report.suppliers.differences).toEqual([
      { store: "suppliers", legacyId: "sup-1", legacyBalanceP: 870_000, newBalanceP: 1_120_000, diffP: 250_000 },
    ]);
    expect(report.customers.differences).toEqual([]);
    expect(report.trialBalance.balanced).toBe(true);
    expect(report.statements.mismatches.map((m) => m.legacyId)).toEqual(["sup-1"]);
  });

  it("a stray entry posted to a shop with no documents names that shop", async () => {
    const [c] = await sql`SELECT id FROM customers WHERE legacy_id = 'cust-6'`;
    await sql.begin(async (tx) => {
      const [e] = await tx`INSERT INTO journal_entries (date, memo, source_type, source_id) VALUES ('2026-02-01', 'stray', 'INVOICE', gen_random_uuid()) RETURNING id`;
      await tx`INSERT INTO journal_lines (entry_id, account_id, party_type, party_id, debit_p, credit_p)
               SELECT ${e!.id}, id, 'CUSTOMER', ${c!.id}, 5000, 0 FROM accounts WHERE code = 'RECEIVABLES'`;
      await tx`INSERT INTO journal_lines (entry_id, account_id, debit_p, credit_p)
               SELECT ${e!.id}, id, 0, 5000 FROM accounts WHERE code = 'SALES'`;
    });

    const report = await reconcile(fixture(), TEST_ADMIN_URL);
    expect(report.ok).toBe(false);
    expect(report.customers.differences.map((d) => [d.legacyId, d.diffP])).toEqual([["cust-6", 5_000]]);
  });

  it("an unbalanced entry (balance trigger bypassed) fails the trial balance", async () => {
    const id = await entryId("INVOICE", "invoices", "inv-5");
    try {
      await sql`ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_balance_check`;
      await sql`UPDATE journal_lines SET debit_p = debit_p + 1 WHERE entry_id = ${id} AND debit_p > 0`;
      const report = await reconcile(fixture(), TEST_ADMIN_URL);
      expect(report.ok).toBe(false);
      expect(exitCodeFor(report)).toBe(1);
      expect(report.trialBalance).toMatchObject({ balanced: false, unbalancedEntries: 1, debitP: 9_305_001, creditP: 9_305_000 });
    } finally {
      await sql`ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_balance_check`;
    }
  });

  it("a row count that no longer matches the backup fails", async () => {
    await sql`DELETE FROM payment_allocations WHERE legacy_id = 'al-1'`;
    const report = await reconcile(fixture(), TEST_ADMIN_URL);
    expect(report.ok).toBe(false);
    expect(report.counts.find((c) => c.store === "paymentAllocations")).toMatchObject({ backup: 4, loaded: 3, match: false });
    expect(report.failures).toContain("store 'paymentAllocations': backup has 4 documents but 3 rows were loaded");
  });
});
