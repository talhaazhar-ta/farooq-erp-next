import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { exitCodeFor, reconcile, runImport, type ImportResult, type ReconciliationReport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, journalBalance } from "./helpers.js";


const sql = adminSql();
let result: ImportResult;
let report: ReconciliationReport;

beforeAll(async () => {
  result = await runImport(fixture(), IMPORT_OPTS);
  report = await reconcile(fixture(), TEST_ADMIN_URL);
});
afterAll(async () => {
  await sql.end();
});

describe("fixture import + reconciliation (the proof that exercises every ledger branch)", () => {
  it("reconciles to the paisa: 0 differences, trial balance balanced, statements match, counts match", () => {
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(exitCodeFor(report)).toBe(0);
    expect(report.customers).toEqual({ compared: 6, differences: [] });
    expect(report.suppliers).toEqual({ compared: 5, differences: [] });
    expect(report.statements.partiesCompared).toBe(11);
    expect(report.statements.mismatches).toEqual([]);
    expect(report.counts.filter((c) => c.class === "imported").every((c) => c.match)).toBe(true);
  });

  it("totals equal the hand-computed sums", () => {
    // receivables: 1,900,000 + 100,000 + 470,000 + 15,000 + 450,000 + 0
    expect(report.totals.receivables).toEqual({ legacyNetP: 2_935_000, newNetP: 2_935_000, legacyPositiveP: 2_935_000, newPositiveP: 2_935_000 });
    // payables: 870,000 + 390,000 - 40,000 + 92,000 + 0 (net); owed>0 leaves out the -40,000
    expect(report.totals.payables).toEqual({ legacyNetP: 1_312_000, newNetP: 1_312_000, legacyPositiveP: 1_352_000, newPositiveP: 1_352_000 });
  });

  it("posts exactly the hand-counted entries and the trial balance is sum(debit) == sum(credit) == 9,305,000", () => {
    // 4 openings + 6 invoices + (7 payments + 2 reversals) + 3 customer returns + 2 supplier returns + 3 purchases
    // + (3 adjustments + 1 reversal) + 4 milling entries (job 1: issue/received/fee; job 2: fee)
    expect(result.journalEntries).toBe(35);
    expect(result.journalLines).toBe(70);
    expect(report.trialBalance).toEqual({ entries: 35, lines: 70, debitP: 9_305_000, creditP: 9_305_000, balanced: true, unbalancedEntries: 0 });
  });

  it("party balances read straight from the journal match the hand-computed values (independent of LegacyLedger)", async () => {
    for (const [id, p] of [["cust-1", 1_900_000], ["cust-2", 100_000], ["cust-3", 470_000], ["cust-4", 15_000], ["cust-5", 450_000], ["cust-6", 0]] as const) {
      expect(await journalBalance(sql, "customers", id)).toBe(p);
    }
    for (const [id, p] of [["sup-1", 870_000], ["sup-2", 390_000], ["sup-3", -40_000], ["sup-4", 92_000], ["sup-5", 0]] as const) {
      expect(await journalBalance(sql, "suppliers", id)).toBe(p);
    }
  });

  it("the two known same-day orderings differ from legacy (informational): C1's refund/return and S1's payment/purchase", () => {
    expect(report.statements.intraDayOrderDiffs).toBe(2);
  });

  it("reports the paper-book parties that were deliberately not posted", async () => {
    expect(report.paperBook).toEqual({ customers: 1, suppliers: 1 });
    expect(await journalBalance(sql, "customers", "cust-6")).toBe(0);
    const [d] = await sql`SELECT legacy_doc->>'legacyBalanceSigned' AS v FROM customers WHERE legacy_id = 'cust-6'`;
    expect(d!.v).toBe("1000000"); // kept in legacy_doc, reference-only
  });

  it("loads every imported store (row counts)", () => {
    expect(result.loaded).toEqual({
      // S6: a second warehouse; 11 invoice lines; S11: 5 purchase lines and their stock; stock levels = 6 stock rows + 1 damaged row; 30 stock movements
      regions: 2, warehouses: 2, products: 3, customers: 6, suppliers: 5, invoices: 8, invoice_items: 11, stock_levels: 7,
      stock_movements: 32, purchases: 4, purchase_items: 5, payments: 7,
      payment_allocations: 4, returns: 7, account_adjustments: 3, milling_jobs: 3, company_profile: 1, sequences: 8,
    });
  });

  it("S3 columns: each customer return is linked to its invoice; a REVERSED payment carries reversed_at / reverse_reason", async () => {
    const links = await sql`
      SELECT r.legacy_id AS ret, i.legacy_id AS inv FROM returns r JOIN invoices i ON i.id = r.invoice_id
      WHERE r.kind = 'CUSTOMER' ORDER BY r.legacy_id`;
    expect(links.map((l) => [l.ret, l.inv])).toEqual([["cr-1", "inv-8"], ["cr-2", "inv-7"], ["cr-3", "inv-6"], ["cr-4", "inv-7"]]);
    const [sup] = await sql`SELECT count(*)::int AS n FROM returns WHERE kind = 'SUPPLIER' AND invoice_id IS NOT NULL`;
    expect(sup!.n).toBe(0);
    const rev = await sql`SELECT legacy_id, reversed_at, reverse_reason FROM payments WHERE status = 'REVERSED' ORDER BY legacy_id`;
    expect(rev.map((r) => [r.legacy_id, r.reverse_reason])).toEqual([["pay-2", "wrong shop"], ["pay-5", "duplicate"]]);
    expect(new Date(rev[0]!.reversed_at).toISOString()).toBe("2026-02-07T08:00:00.000Z");
    const [posted] = await sql`SELECT count(*)::int AS n FROM payments WHERE status = 'POSTED' AND (reversed_at IS NOT NULL OR reverse_reason IS NOT NULL)`;
    expect(posted!.n).toBe(0);
  });

  it("loads the sequence counters exactly as in the backup, so S3's next receipt number continues from the live one", async () => {
    const backup = fixture();
    const rows = await sql`SELECT kind, year, n FROM sequences ORDER BY kind`;
    const expected = backup.data.sequences!.map((s: any) => ({ kind: s.kind, year: s.year, n: s.n })).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(rows.map((r) => ({ kind: r.kind, year: r.year, n: r.n }))).toEqual(expected);
  });

  it("skipped documents are still imported as rows, just without a journal entry (DRAFT / CANCELLED)", async () => {
    const rows = await sql`
      SELECT i.legacy_id, i.status, i.invoice_number,
             (SELECT count(*) FROM journal_entries e WHERE e.source_type = 'INVOICE' AND e.source_id = i.id)::int AS entries
      FROM invoices i WHERE i.legacy_id IN ('inv-3', 'inv-4') ORDER BY i.legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.status, r.invoice_number, r.entries])).toEqual([
      ["inv-3", "DRAFT", null, 0], // drafts carry no number
      ["inv-4", "CANCELLED", "INV-2026-000003", 0],
    ]);
  });

  it("quirk: DRAFT purchases and DRAFT returns DO post (only CANCELLED is skipped)", async () => {
    const rows = await sql`
      SELECT s.legacy_id, count(e.id)::int AS entries FROM (
        SELECT legacy_id, id, 'PURCHASE' AS t FROM purchases WHERE legacy_id IN ('pur-2', 'pur-3')
        UNION ALL SELECT legacy_id, id, 'CUSTOMER_RETURN' FROM returns WHERE legacy_id IN ('cr-2', 'cr-3')
        UNION ALL SELECT legacy_id, id, 'SUPPLIER_RETURN' FROM returns WHERE legacy_id IN ('sr-2', 'sr-3')
      ) s LEFT JOIN journal_entries e ON e.source_id = s.id AND e.source_type = s.t
      GROUP BY s.legacy_id ORDER BY s.legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.entries])).toEqual([
      ["cr-2", 0], ["cr-3", 1], ["pur-2", 1], ["pur-3", 0], ["sr-2", 0], ["sr-3", 1],
    ]);
  });

  it("a REVERSED payment posts the original AND a reversing entry on the same date, netting to zero", async () => {
    const [p] = await sql`SELECT id, status FROM payments WHERE legacy_id = 'pay-2'`;
    expect(p!.status).toBe("REVERSED");
    const entries = await sql`
      SELECT e.source_type, e.date::text AS d, SUM(l.debit_p)::int AS dr, SUM(l.credit_p)::int AS cr,
             SUM(CASE WHEN a.code = 'RECEIVABLES' THEN l.credit_p - l.debit_p ELSE 0 END)::int AS recv_credit
      FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
      WHERE e.source_id = ${p!.id} GROUP BY e.source_type, e.date ORDER BY e.source_type`;
    expect(entries.map((e) => [e.source_type, e.d, e.dr, e.cr, e.recv_credit])).toEqual([
      ["PAYMENT", "2026-02-06", 200_000, 200_000, 200_000],
      ["PAYMENT_REVERSAL", "2026-02-06", 200_000, 200_000, -200_000],
    ]);
  });

  it("a REFUND-treatment return is linked to its cash payment (reference + note prefix, as the legacy editAmount check does)", async () => {
    const rows = await sql`
      SELECT r.legacy_id, p.legacy_id AS pay FROM returns r LEFT JOIN payments p ON p.id = r.refund_payment_id ORDER BY r.legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.pay])).toEqual([
      ["cr-1", "pay-7"], ["cr-2", null], ["cr-3", null], ["cr-4", null], ["sr-1", null], ["sr-2", null], ["sr-3", null],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("a negative opening balance posts with the sides swapped, dated 2000-01-01 when it has no date", async () => {
    const rows = await sql`
      SELECT e.date::text AS d, a.code, l.debit_p::int AS dr, l.credit_p::int AS cr
      FROM customers c JOIN journal_entries e ON e.source_id = c.id AND e.source_type = 'CUSTOMER_OPENING'
      JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
      WHERE c.legacy_id = 'cust-2' ORDER BY a.code`;
    expect(rows.map((r) => [r.d, r.code, r.dr, r.cr])).toEqual([
      ["2000-01-01", "OPENING_EQUITY", 200_000, 0],
      ["2000-01-01", "RECEIVABLES", 0, 200_000],
    ]);
  });

  it("FEE_ONLY milling posts the fee only; a job's three rows are ordered by +0/+1/+2 ms on created_at", async () => {
    const rows = await sql`
      SELECT j.legacy_id, e.source_type, e.created_at FROM milling_jobs j
      JOIN journal_entries e ON e.source_id = j.id AND e.source_type LIKE 'MILLING_%'
      WHERE j.legacy_id IN ('mil-1', 'mil-2') ORDER BY j.legacy_id, e.created_at`;
    expect(rows.map((r) => [r.legacy_id, r.source_type])).toEqual([
      ["mil-1", "MILLING_ISSUE"], ["mil-1", "MILLING_RECEIVED"], ["mil-1", "MILLING_FEE"], ["mil-2", "MILLING_FEE"],
    ]);
    const t = rows.filter((r) => r.legacy_id === "mil-1").map((r) => new Date(r.created_at).getTime());
    expect([t[1]! - t[0]!, t[2]! - t[1]!]).toEqual([1, 1]);
  });

  it("journal entries carry the legacy createdAt (statement order depends on it)", async () => {
    const [e] = await sql`
      SELECT e.created_at FROM invoices i JOIN journal_entries e ON e.source_id = i.id AND e.source_type = 'INVOICE' WHERE i.legacy_id = 'inv-1'`;
    expect(new Date(e!.created_at).toISOString()).toBe("2026-02-01T05:00:00.000Z");
  });

  it("stores Urdu (UTF-8) names intact, in columns and in legacy_doc", async () => {
    const [c] = await sql`SELECT shop_name, owner_name, legacy_doc->>'sh' AS doc_sh FROM customers WHERE legacy_id = 'cust-5'`;
    expect([c!.shop_name, c!.owner_name, c!.doc_sh]).toEqual(["دکان فاروق", "فاروق", "دکان فاروق"]);
    const [s] = await sql`SELECT company_name FROM suppliers WHERE legacy_id = 'sup-4'`;
    expect(s!.company_name).toBe("الفلاح ملز");
    const [enc] = await sql`SELECT pg_encoding_to_char(encoding) AS e FROM pg_database WHERE datname = current_database()`;
    expect(enc!.e).toBe("UTF8");
  });

  it("keeps the untouched legacy document in legacy_doc, and business dates as plain strings", async () => {
    const original = fixture().data.invoices!.find((d: any) => d.id === "inv-1");
    const [row] = await sql`SELECT legacy_doc, date::text AS d FROM invoices WHERE legacy_id = 'inv-1'`;
    expect(row!.legacy_doc).toEqual(original);
    expect(row!.d).toBe("2026-02-01");
  });

  it("falls back to en / cat for products without name / category (older shape)", async () => {
    const [p] = await sql`SELECT name, category, unit FROM products WHERE legacy_id = 'p-3'`;
    expect([p!.name, p!.category, p!.unit]).toEqual(["Fixture Rice", "Rice", null]);
  });

  it("never imports the users store: no user row, and its credentials appear nowhere in any legacy_doc", async () => {
    const [u] = await sql`SELECT count(*)::int AS n FROM users WHERE legacy_id = 'u-1' OR name = 'Fixture Owner'`;
    expect(u!.n).toBe(0);
    const [leak] = await sql`
      SELECT count(*)::int AS n FROM (
        SELECT legacy_doc FROM customers UNION ALL SELECT legacy_doc FROM suppliers UNION ALL SELECT legacy_doc FROM invoices
        UNION ALL SELECT legacy_doc FROM payments UNION ALL SELECT legacy_doc FROM products) x
      WHERE legacy_doc::text LIKE '%FIXTURE-PIN%' OR legacy_doc::text LIKE '%FIXTURE-SALT%'`;
    expect(leak!.n).toBe(0);
  });

  it("writes one IMPORT audit_log row with the counts, source and exportedAt", async () => {
    const rows = await sql`SELECT entity_id, after FROM audit_log WHERE action = 'IMPORT' ORDER BY at DESC LIMIT 1`;
    expect(rows[0]!.entity_id).toBe("test");
    expect(rows[0]!.after.exportedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(rows[0]!.after.journalEntries).toBe(35);
    expect(rows[0]!.after.storeCounts.customers).toBe(6);
  });
});
