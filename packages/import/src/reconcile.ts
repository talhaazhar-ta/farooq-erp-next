import postgres from "postgres";
import { createLegacyLedger, type LedgerRow } from "./legacy-ledger.js";
import { assertLocalDatabaseUrl } from "./load.js";
import { classifyStore, type Backup } from "./validate.js";

/**
 * The reconciliation report is the definition of "correct" (CLAUDE.md rule 8): for every shop and supplier it
 * compares the balance the OLD algorithm computes from the raw backup (`LegacyLedger`, no database) against the
 * balance of the NEW double-entry journal. Neither side calls the other.
 */

export interface PartyDiff {
  store: "customers" | "suppliers";
  legacyId: string;
  legacyBalanceP: number;
  newBalanceP: number;
  diffP: number;
}

export interface StatementMismatch {
  store: "customers" | "suppliers";
  legacyId: string;
  detail: string;
}

export interface CountRow {
  store: string;
  class: "imported" | "deferred" | "ignored";
  backup: number;
  loaded: number | null;
  match: boolean | null;
}

export interface ReconciliationReport {
  ok: boolean;
  exportedAt: string;
  generatedAt: string;
  failures: string[];
  customers: { compared: number; differences: PartyDiff[] };
  suppliers: { compared: number; differences: PartyDiff[] };
  totals: {
    receivables: { legacyNetP: number; newNetP: number; legacyPositiveP: number; newPositiveP: number };
    payables: { legacyNetP: number; newNetP: number; legacyPositiveP: number; newPositiveP: number };
  };
  trialBalance: { entries: number; lines: number; debitP: number; creditP: number; balanced: boolean; unbalancedEntries: number };
  counts: CountRow[];
  statements: { partiesCompared: number; mismatches: StatementMismatch[]; intraDayOrderDiffs: number };
  paperBook: { customers: number; suppliers: number };
}

/** Which table (and filter) holds each imported store's rows. */
const LOADED_COUNT_SQL: Record<string, string> = {
  regions: "SELECT count(*) AS n FROM regions",
  warehouses: "SELECT count(*) AS n FROM warehouses",
  products: "SELECT count(*) AS n FROM products",
  customers: "SELECT count(*) AS n FROM customers",
  suppliers: "SELECT count(*) AS n FROM suppliers",
  invoices: "SELECT count(*) AS n FROM invoices",
  purchases: "SELECT count(*) AS n FROM purchases",
  payments: "SELECT count(*) AS n FROM payments",
  paymentAllocations: "SELECT count(*) AS n FROM payment_allocations",
  customerReturns: "SELECT count(*) AS n FROM returns WHERE kind = 'CUSTOMER'",
  supplierReturns: "SELECT count(*) AS n FROM returns WHERE kind = 'SUPPLIER'",
  sequences: "SELECT count(*) AS n FROM sequences",
  accountAdjustments: "SELECT count(*) AS n FROM account_adjustments",
  millingJobs: "SELECT count(*) AS n FROM milling_jobs",
};

/** 0 when the backup reconciles to the paisa, 1 otherwise — the CLI's process exit code. */
export const exitCodeFor = (report: ReconciliationReport): number => (report.ok ? 0 : 1);

/** Local wall-clock stamp for file names / the report header (business-local, never toISOString). */
export function localStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface NewRow {
  iso: string;
  kind: string;
  ref: string;
  delta: number;
  createdAt: number;
  isOpening: boolean;
}

const rowKey = (iso: string, kind: string, ref: string, delta: number) => `${iso}|${kind}|${ref}|${delta}`;

/**
 * Statement order rule for the NEW ledger (defined here, documented in STATUS for S4): rows are ordered by
 * business date, then journal created_at, then entry id. For CUSTOMERS the opening-balance row comes first
 * whatever its date, because the legacy customer statement (16-khata.js) does. Reversed payments/adjustments
 * (and their reversal entries) are omitted from statements, because the legacy statement never shows them.
 */
function orderNewRows(rows: (NewRow & { id: string })[], isCustomer: boolean): NewRow[] {
  return [...rows].sort((a, b) => {
    if (isCustomer && a.isOpening !== b.isOpening) return a.isOpening ? -1 : 1;
    if (a.iso !== b.iso) return a.iso < b.iso ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function reconcile(backup: Backup, databaseUrl: string): Promise<ReconciliationReport> {
  assertLocalDatabaseUrl(databaseUrl);
  const legacy = createLegacyLedger(backup.data);
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const failures: string[] = [];
    const num = (v: unknown) => Number(v);

    const accountRows = await client`SELECT id, code FROM accounts`;
    const accountId = (code: string) => accountRows.find((a) => a.code === code)?.id as string | undefined;
    const receivables = accountId("RECEIVABLES");
    const payables = accountId("PAYABLES");
    if (!receivables || !payables) throw new Error("Control accounts RECEIVABLES/PAYABLES are missing — is the database migrated?");

    const customerRows = await client`SELECT id, legacy_id FROM customers`;
    const supplierRows = await client`SELECT id, legacy_id FROM suppliers`;
    const customerUuid = new Map<string, string>(customerRows.map((r) => [r.legacy_id as string, r.id as string]));
    const supplierUuid = new Map<string, string>(supplierRows.map((r) => [r.legacy_id as string, r.id as string]));

    /* ── closing balances ──────────────────────────────────────────────── */
    const balanceOf = async (accountUuid: string): Promise<Map<string, number>> => {
      const rows = await client`
        SELECT party_id, COALESCE(SUM(debit_p), 0)::text AS d, COALESCE(SUM(credit_p), 0)::text AS c
        FROM journal_lines WHERE account_id = ${accountUuid} AND party_id IS NOT NULL GROUP BY party_id`;
      return new Map(rows.map((r) => [r.party_id as string, num(r.d) - num(r.c)]));
    };
    const recvByParty = await balanceOf(receivables);
    const payByParty = await balanceOf(payables);

    const customers: ReconciliationReport["customers"] = { compared: 0, differences: [] };
    const suppliers: ReconciliationReport["suppliers"] = { compared: 0, differences: [] };
    const totals = {
      receivables: { legacyNetP: 0, newNetP: 0, legacyPositiveP: 0, newPositiveP: 0 },
      payables: { legacyNetP: 0, newNetP: 0, legacyPositiveP: 0, newPositiveP: 0 },
    };
    const legacyCustomer = new Map<string, ReturnType<typeof legacy.customer>>();
    const legacySupplier = new Map<string, ReturnType<typeof legacy.supplier>>();

    for (const legacyId of legacy.customerIds) {
      const L = legacy.customer(legacyId);
      legacyCustomer.set(legacyId, L);
      const uuid = customerUuid.get(legacyId);
      if (!uuid) {
        failures.push(`customer ${legacyId} is in the backup but not in the database`);
        continue;
      }
      const newP = recvByParty.get(uuid) ?? 0; // a party with no lines has balance 0
      customers.compared++;
      totals.receivables.legacyNetP += L.closing;
      totals.receivables.newNetP += newP;
      totals.receivables.legacyPositiveP += Math.max(0, L.closing);
      totals.receivables.newPositiveP += Math.max(0, newP);
      if (L.closing !== newP) customers.differences.push({ store: "customers", legacyId, legacyBalanceP: L.closing, newBalanceP: newP, diffP: newP - L.closing });
    }
    for (const legacyId of legacy.supplierIds) {
      const L = legacy.supplier(legacyId);
      legacySupplier.set(legacyId, L);
      const uuid = supplierUuid.get(legacyId);
      if (!uuid) {
        failures.push(`supplier ${legacyId} is in the backup but not in the database`);
        continue;
      }
      const newP = -(payByParty.get(uuid) ?? 0); // payables: credit - debit
      suppliers.compared++;
      totals.payables.legacyNetP += L.closing;
      totals.payables.newNetP += newP;
      totals.payables.legacyPositiveP += Math.max(0, L.closing);
      totals.payables.newPositiveP += Math.max(0, newP);
      if (L.closing !== newP) suppliers.differences.push({ store: "suppliers", legacyId, legacyBalanceP: L.closing, newBalanceP: newP, diffP: newP - L.closing });
    }
    // Extra parties in the database that the backup does not have.
    const extraCustomers = customerRows.length - customers.compared;
    const extraSuppliers = supplierRows.length - suppliers.compared;
    if (extraCustomers > 0) failures.push(`${extraCustomers} customer(s) in the database are not in the backup`);
    if (extraSuppliers > 0) failures.push(`${extraSuppliers} supplier(s) in the database are not in the backup`);

    if (customers.differences.length) failures.push(`${customers.differences.length} customer balance difference(s)`);
    if (suppliers.differences.length) failures.push(`${suppliers.differences.length} supplier balance difference(s)`);

    /* ── trial balance ─────────────────────────────────────────────────── */
    const [tb] = await client`
      SELECT (SELECT count(*) FROM journal_entries)::text AS entries,
             count(*)::text AS lines,
             COALESCE(SUM(debit_p), 0)::text AS d, COALESCE(SUM(credit_p), 0)::text AS c
      FROM journal_lines`;
    const [unb] = await client`
      SELECT count(*)::text AS n FROM (
        SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_p) <> SUM(credit_p)) x`;
    const trialBalance = {
      entries: num(tb!.entries),
      lines: num(tb!.lines),
      debitP: num(tb!.d),
      creditP: num(tb!.c),
      balanced: num(tb!.d) === num(tb!.c) && num(unb!.n) === 0,
      unbalancedEntries: num(unb!.n),
    };
    if (!trialBalance.balanced) failures.push(`trial balance is off (debit ${trialBalance.debitP} vs credit ${trialBalance.creditP}, ${trialBalance.unbalancedEntries} unbalanced entries)`);

    /* ── per-store counts ──────────────────────────────────────────────── */
    const counts: CountRow[] = [];
    for (const [store, docs] of Object.entries(backup.data)) {
      const cls = classifyStore(store);
      if (cls === null) {
        failures.push(`store '${store}' is unclassified`);
        continue;
      }
      if (cls === "imported") {
        const q = LOADED_COUNT_SQL[store];
        const loaded = q ? num((await client.unsafe(q))[0]?.n) : null;
        const match = loaded === docs.length;
        if (!match) failures.push(`store '${store}': backup has ${docs.length} documents but ${loaded} rows were loaded`);
        counts.push({ store, class: cls, backup: docs.length, loaded, match });
      } else {
        counts.push({ store, class: cls, backup: docs.length, loaded: null, match: null });
      }
    }

    /* ── statement check ───────────────────────────────────────────────── */
    const sourceRef = new Map<string, { ref: string; kind: string; reversed: boolean }>();
    const collect = async (rows: Promise<postgres.RowList<postgres.Row[]>>, kindOf: (r: postgres.Row) => string, refCol: string, reversedOf?: (r: postgres.Row) => boolean) => {
      for (const r of await rows) sourceRef.set(r.id as string, { ref: (r[refCol] as string | null) ?? "", kind: kindOf(r), reversed: reversedOf ? reversedOf(r) : false });
    };
    // Keyed by source id; source types never collide because ids are UUIDv5 of "<store>:<legacy id>".
    await collect(client`SELECT id, invoice_number FROM invoices`, () => "INVOICE", "invoice_number");
    await collect(client`SELECT id, purchase_number FROM purchases`, () => "PURCHASE", "purchase_number");
    await collect(client`SELECT id, receipt_number, direction, party_type, status FROM payments`,
      (r) => (r.direction === "OUT" && r.party_type === "CUSTOMER" ? "REFUND" : "PAYMENT"), "receipt_number", (r) => r.status === "REVERSED");
    await collect(client`SELECT id, return_number FROM returns`, () => "RETURN", "return_number");
    await collect(client`SELECT id, adjustment_number, status FROM account_adjustments`, () => "ADJUSTMENT", "adjustment_number", (r) => r.status === "REVERSED");
    await collect(client`SELECT id, job_number FROM milling_jobs`, () => "MILLING", "job_number");

    const stmtRows = async (accountUuid: string) =>
      client`
        SELECT l.party_id, e.id AS entry_id, e.date::text AS date, e.created_at, e.source_type, e.source_id,
               l.debit_p::text AS d, l.credit_p::text AS c
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = ${accountUuid} AND l.party_id IS NOT NULL`;

    const buildNew = (rows: postgres.RowList<postgres.Row[]>, credited: boolean) => {
      const byParty = new Map<string, (NewRow & { id: string })[]>();
      for (const r of rows) {
        const st = r.source_type as string;
        const isOpening = st === "CUSTOMER_OPENING" || st === "SUPPLIER_OPENING";
        const src = sourceRef.get(r.source_id as string);
        // Reversed payments/adjustments: legacy hides both the original and its reversal.
        if (src?.reversed && (st.endsWith("_REVERSAL") || st === "PAYMENT" || st === "ADJUSTMENT")) continue;
        const delta = credited ? num(r.c) - num(r.d) : num(r.d) - num(r.c);
        const kind = isOpening ? "OPENING" : st.startsWith("MILLING_") ? "MILLING" : (src?.kind ?? st);
        const row = { iso: r.date as string, kind, ref: isOpening ? "OPENING" : (src?.ref ?? ""), delta, createdAt: new Date(r.created_at as string | Date).getTime(), isOpening, id: r.entry_id as string };
        const list = byParty.get(r.party_id as string);
        if (list) list.push(row);
        else byParty.set(r.party_id as string, [row]);
      }
      return byParty;
    };
    const newCust = buildNew(await stmtRows(receivables), false);
    const newSupp = buildNew(await stmtRows(payables), true);

    const mismatches: StatementMismatch[] = [];
    let intraDayOrderDiffs = 0;
    const compareStatements = (store: "customers" | "suppliers", ids: string[], uuidOf: Map<string, string>, legacyOf: Map<string, { rows: LedgerRow[] }>, newBy: Map<string, (NewRow & { id: string })[]>, credited: boolean) => {
      for (const legacyId of ids) {
        const uuid = uuidOf.get(legacyId);
        if (!uuid) continue;
        const legacyRows = legacyOf.get(legacyId)!.rows.map((r) => rowKey(r.iso, r.kind, r.ref ?? "", credited ? r.cr - r.dr : r.dr - r.cr));
        const newRows = orderNewRows(newBy.get(uuid) ?? [], !credited).map((r) => rowKey(r.iso, r.kind, r.ref, r.delta));
        const a = [...legacyRows].sort().join("\n");
        const b = [...newRows].sort().join("\n");
        if (a !== b) {
          mismatches.push({ store, legacyId, detail: `statement rows differ (legacy ${legacyRows.length} rows, new ${newRows.length} rows)` });
        } else if (legacyRows.join("\n") !== newRows.join("\n")) {
          intraDayOrderDiffs++; // same rows, different order within a day (legacy quirk — see STATUS)
        }
      }
    };
    compareStatements("customers", legacy.customerIds, customerUuid, legacyCustomer, newCust, false);
    compareStatements("suppliers", legacy.supplierIds, supplierUuid, legacySupplier, newSupp, true);
    if (mismatches.length) failures.push(`${mismatches.length} statement mismatch(es)`);

    return {
      ok: failures.length === 0,
      exportedAt: backup.exportedAt,
      generatedAt: localStamp(),
      failures,
      customers,
      suppliers,
      totals,
      trialBalance,
      counts,
      statements: { partiesCompared: customers.compared + suppliers.compared, mismatches, intraDayOrderDiffs },
      paperBook: legacy.paperBookParties(),
    };
  } finally {
    await client.end();
  }
}

/** The human-readable report: real numbers, not just "OK". */
export function formatReport(r: ReconciliationReport): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const out: string[] = [];
  out.push(`Reconciliation — backup exported ${r.exportedAt}, checked ${r.generatedAt}`);
  out.push("");
  out.push(`Customers   ${n(r.customers.compared)} compared, ${r.customers.differences.length} balance difference(s)`);
  out.push(`Suppliers   ${n(r.suppliers.compared)} compared, ${r.suppliers.differences.length} balance difference(s)`);
  for (const d of [...r.customers.differences, ...r.suppliers.differences]) {
    out.push(`  ✗ ${d.store} ${d.legacyId}: legacy ${n(d.legacyBalanceP)} paisa, new ${n(d.newBalanceP)} paisa (diff ${n(d.diffP)})`);
  }
  out.push("");
  out.push("Totals (paisa)                 legacy            new");
  const t = r.totals;
  const row = (label: string, a: number, b: number) => out.push(`  ${label.padEnd(26)}${n(a).padStart(14)}${n(b).padStart(15)}${a === b ? "" : "   ✗"}`);
  row("receivables (net)", t.receivables.legacyNetP, t.receivables.newNetP);
  row("receivables (owed > 0)", t.receivables.legacyPositiveP, t.receivables.newPositiveP);
  row("payables (net)", t.payables.legacyNetP, t.payables.newNetP);
  row("payables (owed > 0)", t.payables.legacyPositiveP, t.payables.newPositiveP);
  out.push("");
  const tb = r.trialBalance;
  out.push(`Trial balance  ${n(tb.entries)} entries, ${n(tb.lines)} lines: debit ${n(tb.debitP)} / credit ${n(tb.creditP)} paisa — ${tb.balanced ? "BALANCED" : "OFF"}`);
  out.push("");
  out.push("Store counts   (backup → loaded)");
  for (const c of r.counts) {
    const loaded = c.class === "imported" ? `${n(c.loaded ?? 0)} loaded ${c.match ? "✓" : "✗"}` : `not loaded (${c.class})`;
    out.push(`  ${c.store.padEnd(22)}${String(n(c.backup)).padStart(7)}  ${loaded}`);
  }
  out.push("");
  out.push(`Statements     ${n(r.statements.partiesCompared)} parties compared, ${r.statements.mismatches.length} row mismatch(es); ${r.statements.intraDayOrderDiffs} party statement(s) list same-day rows in a different order (informational — legacy tie-break quirk)`);
  out.push(`Paper-book     ${r.paperBook.customers} customers and ${r.paperBook.suppliers} suppliers carry a nonzero legacy paper-book figure — deliberately NOT posted (needs an owner-chosen cutover date)`);
  out.push("");
  out.push(r.ok ? "RESULT: PASS — 0 differences" : `RESULT: FAIL — ${r.failures.join("; ")}`);
  return out.join("\n");
}
