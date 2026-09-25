import postgres from "postgres";
import { createLegacyLedger, type LedgerRow } from "./legacy-ledger.js";
import { assertLocalDatabaseUrl } from "./load.js";
import { checkPurchases } from "./reconcile-purchases.js";
import { checkInvoicesAndStock } from "./reconcile-stock.js";
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

/** One invoice whose lines do not add up to what the header says (or whose lines do not add up at all). */
export interface InvoiceMismatch {
  invoice: string;
  problems: string[];
}

/** One product x warehouse x bucket whose legacy quantity, stock level and sum of movements are not all equal. */
export interface StockMismatch {
  product: string;
  warehouse: string;
  bucket: string;
  legacyMilli: number;
  levelMilli: number;
  movementsMilli: number;
}

/** One invoice whose stock movements do not net to what its lines say they should. */
export interface InvoiceStockMismatch {
  invoice: string;
  product: string;
  expectedMilli: number;
  netMilli: number;
}

/** One purchase whose lines do not add up to what the header says. */
export interface PurchaseMismatch {
  purchase: string;
  problems: string[];
}

/** One purchase x product x warehouse whose stock movements do not net to the bags its lines say arrived. */
export interface PurchaseStockMismatch {
  purchase: string;
  product: string;
  warehouse: string;
  expectedMilli: number;
  netMilli: number;
}

/** One stock row whose imported average cost is not what the purchase lines give. */
export interface AverageCostMismatch {
  product: string;
  warehouse: string;
  purchaseLines: number;
  recomputedP: number | null;
  storedP: number;
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
  /** S6: every invoice's total recomputed from its lines with the shared port of the legacy `Calc`. */
  invoices: {
    /** Non-draft invoices that have lines: recomputed and compared. */
    checked: number;
    lines: number;
    /** Σ quantity on the checked invoices' lines, thousandths of a bag. */
    qtyMilli: number;
    totalMismatches: InvoiceMismatch[];
    /** Non-draft invoices with no lines (possible for migrated ones): listed, not failed. */
    noLines: string[];
    drafts: number;
    /** Invoices the old app's data migration made: checked too, but a mismatch is informational (their totals never came from Calc). */
    migrated: string[];
    migratedMismatches: InvoiceMismatch[];
  };
  /** S6: legacy inventory = stock_levels = Σ stock_movements, per product x warehouse x bucket. */
  stock: {
    rows: number;
    movements: number;
    /** Σ stock-bucket / damaged-bucket quantity, thousandths. */
    stockQtyMilli: number;
    damagedQtyMilli: number;
    mismatches: StockMismatch[];
    /** Informational: legacy `balanceAfter` chains that do not follow their own movements. */
    chainGaps: number;
  };
  /** S6: a posted invoice's stock movements net to minus its line quantities (an edit's reversal + re-deduct nets out). */
  invoiceStock: { invoicesChecked: number; migratedSkipped: number; movementsChecked: number; mismatches: InvoiceStockMismatch[] };
  /** S11: every purchase's total recomputed from its lines with the shared port of the legacy `Calc` (purchases reuse `Calc.invoice`). */
  purchases: {
    /** Non-cancelled purchases that have lines: recomputed and compared. */
    checked: number;
    lines: number;
    /** Σ ordered / received bags on the checked purchases' lines, thousandths. */
    orderedQtyMilli: number;
    receivedQtyMilli: number;
    totalMismatches: PurchaseMismatch[];
    /** Non-cancelled purchases with no lines (an old backup): listed, not failed. */
    noLines: string[];
    cancelled: number;
    /** Purchases the old app's data migration made: a mismatch is informational (their totals never came from Calc). */
    migrated: string[];
    migratedMismatches: PurchaseMismatch[];
  };
  /** S11: a purchase's stock movements (source PURCHASE) net, per product x warehouse, to the bags its lines received; a cancelled one nets 0. */
  purchaseStock: { purchasesChecked: number; migratedSkipped: string[]; movementsChecked: number; mismatches: PurchaseStockMismatch[] };
  /** S11: the weighted average cost of every stock row that has a purchase line behind it, recomputed; and the pieces S12 relies on. */
  averageCost: {
    /** The profitCostBasis setting the average was recomputed on (missing = LANDED). */
    basis: "LANDED" | "PURCHASE";
    /** Stock rows with a purchase line that received bags: recomputed and compared. */
    rows: number;
    matched: number;
    /** Stock rows with NO purchase line: the legacy keeps their old average, so they are listed, not failed. */
    keptFromBefore: { product: string; warehouse: string; avgCostP: number }[];
    mismatches: AverageCostMismatch[];
    /** Each line's operational share = the sum of its non-cancelled landed-cost rows in the backup (`inventoryCostAdjust`). */
    operationalShare: {
      linesChecked: number;
      withShare: number;
      /** Landed-cost rows whose purchase line is no longer in the backup (informational: the legacy ignores them too). */
      orphanRows: string[];
      mismatches: { purchase: string; line: string; storedP: number; landedCostRowsP: number }[];
    };
    /** Each costed line's landed unit = goods unit + round(charge share / bags) + round(operational share / bags). */
    landedUnit: {
      linesChecked: number;
      skippedNothingReceived: number;
      mismatches: { purchase: string; line: string; storedP: number; recomputedP: number }[];
    };
    /** Informational: the stored goods unit / charge share against `allocateCharges`. They differ on a part delivery ON PURPOSE (fix 3). */
    allocation: {
      linesChecked: number;
      differs: { purchase: string; line: string; storedGoodsUnitP: number; goodsUnitP: number; storedChargeShareP: number; chargeShareP: number }[];
    };
  };
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
  purchaseItems: "SELECT count(*) AS n FROM purchase_items",
  payments: "SELECT count(*) AS n FROM payments",
  paymentAllocations: "SELECT count(*) AS n FROM payment_allocations",
  customerReturns: "SELECT count(*) AS n FROM returns WHERE kind = 'CUSTOMER'",
  supplierReturns: "SELECT count(*) AS n FROM returns WHERE kind = 'SUPPLIER'",
  sequences: "SELECT count(*) AS n FROM sequences",
  accountAdjustments: "SELECT count(*) AS n FROM account_adjustments",
  millingJobs: "SELECT count(*) AS n FROM milling_jobs",
  business: "SELECT count(*) AS n FROM company_profile",
  invoiceItems: "SELECT count(*) AS n FROM invoice_items",
  // one legacy inventory row = a stock row (+ a damaged row when it holds damaged stock)
  inventory: "SELECT count(*) AS n FROM (SELECT DISTINCT product_id, warehouse_id FROM stock_levels) x",
  stockMovements: "SELECT count(*) AS n FROM stock_movements",
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
 * (and their reversal entries) are omitted from statements, because the legacy statement never shows them; so is a CANCELLED
 * invoice with its INVOICE_CANCEL entry (S7).
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
    await collect(client`SELECT id, invoice_number, status FROM invoices`, () => "INVOICE", "invoice_number", (r) => r.status === "CANCELLED");
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
        // A CANCELLED invoice (S7): the legacy ledger skips it, so both its INVOICE entry and its INVOICE_CANCEL entry are left out.
        if (src?.reversed && (st === "INVOICE" || st === "INVOICE_CANCEL")) continue;
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

    /* ── invoice lines + stock (S6) ────────────────────────────────────── */
    const { invoices, stock, invoiceStock } = await checkInvoicesAndStock(client, backup);
    if (invoices.totalMismatches.length) failures.push(`${invoices.totalMismatches.length} invoice total mismatch(es) (lines vs header)`);
    if (stock.mismatches.length) failures.push(`${stock.mismatches.length} stock quantity mismatch(es) (inventory vs stock levels vs movements)`);
    if (invoiceStock.mismatches.length) failures.push(`${invoiceStock.mismatches.length} invoice/stock mismatch(es) (movements vs invoice lines)`);

    /* ── purchase lines, purchase <-> stock, average cost (S11) ────────── */
    const { purchases, purchaseStock, averageCost } = await checkPurchases(client, backup);
    if (purchases.totalMismatches.length) failures.push(`${purchases.totalMismatches.length} purchase total mismatch(es) (lines vs header)`);
    if (purchaseStock.mismatches.length) failures.push(`${purchaseStock.mismatches.length} purchase/stock mismatch(es) (movements vs purchase lines)`);
    if (averageCost.mismatches.length) failures.push(`${averageCost.mismatches.length} average cost mismatch(es) (stock row vs purchase lines)`);
    if (averageCost.operationalShare.mismatches.length) failures.push(`${averageCost.operationalShare.mismatches.length} operational share mismatch(es) (purchase line vs landed-cost rows)`);
    if (averageCost.landedUnit.mismatches.length) failures.push(`${averageCost.landedUnit.mismatches.length} landed unit cost mismatch(es) (purchase line)`);

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
      invoices,
      stock,
      invoiceStock,
      purchases,
      purchaseStock,
      averageCost,
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
  const bags = (m: number) => (m / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const inv = r.invoices;
  out.push(
    `Invoices       ${n(inv.checked)} checked (totals recomputed from ${n(inv.lines)} lines, ${bags(inv.qtyMilli)} bags), ${inv.totalMismatches.length} total mismatch(es); ` +
      `${inv.drafts} draft(s) not checked, ${inv.noLines.length} posted invoice(s) without lines`,
  );
  for (const m of inv.totalMismatches) out.push(`  ✗ invoice ${m.invoice}: ${m.problems.join("; ")}`);
  if (inv.migrated.length) {
    out.push(`  note: ${inv.migrated.length} invoice(s) were made by the old app's data migration (stock applied, no SALE_OUT movements): ${inv.migrated.join(", ")}`);
    for (const m of inv.migratedMismatches) out.push(`  · migrated invoice ${m.invoice} (informational — its totals never came from Calc): ${m.problems.join("; ")}`);
  }
  if (inv.noLines.length) out.push(`  note: no lines on ${inv.noLines.slice(0, 8).join(", ")}${inv.noLines.length > 8 ? ` … and ${inv.noLines.length - 8} more` : ""}`);
  const st = r.stock;
  out.push(
    `Stock          ${n(st.rows)} product x warehouse x bucket rows, ${n(st.movements)} movements, ${bags(st.stockQtyMilli)} bags in stock + ${bags(st.damagedQtyMilli)} damaged; ` +
      `${st.mismatches.length} mismatch(es) (legacy inventory = stock level = Σ movements); ${st.chainGaps} balance-chain gap(s) in the legacy running figures (informational)`,
  );
  for (const m of st.mismatches) {
    out.push(`  ✗ product ${m.product} @ warehouse ${m.warehouse} [${m.bucket}]: legacy ${bags(m.legacyMilli)}, level ${bags(m.levelMilli)}, Σ movements ${bags(m.movementsMilli)}`);
  }
  const is = r.invoiceStock;
  out.push(`Invoice↔stock  ${n(is.invoicesChecked)} invoices vs ${n(is.movementsChecked)} invoice movements, ${is.mismatches.length} mismatch(es); ${is.migratedSkipped} migrated invoice(s) skipped`);
  for (const m of is.mismatches) out.push(`  ✗ invoice ${m.invoice}, product ${m.product}: lines say ${bags(m.expectedMilli)}, movements net ${bags(m.netMilli)}`);
  const pu = r.purchases;
  out.push(
    `Purchases      ${n(pu.checked)} checked (totals recomputed from ${n(pu.lines)} lines, ${bags(pu.orderedQtyMilli)} bags ordered, ${bags(pu.receivedQtyMilli)} received), ${pu.totalMismatches.length} total mismatch(es); ` +
      `${pu.cancelled} cancelled not checked, ${pu.noLines.length} purchase(s) without lines`,
  );
  for (const m of pu.totalMismatches) out.push(`  ✗ purchase ${m.purchase}: ${m.problems.join("; ")}`);
  if (pu.migrated.length) {
    out.push(`  note: ${pu.migrated.length} purchase(s) were made by the old app's data migration: ${pu.migrated.join(", ")}`);
    for (const m of pu.migratedMismatches) out.push(`  · migrated purchase ${m.purchase} (informational — its totals never came from Calc): ${m.problems.join("; ")}`);
  }
  if (pu.noLines.length) out.push(`  note: no lines on ${pu.noLines.slice(0, 8).join(", ")}${pu.noLines.length > 8 ? ` … and ${pu.noLines.length - 8} more` : ""}`);
  const ps = r.purchaseStock;
  out.push(`Purchase↔stock ${n(ps.purchasesChecked)} purchases vs ${n(ps.movementsChecked)} purchase movements, ${ps.mismatches.length} mismatch(es); ${ps.migratedSkipped.length} migrated purchase(s) skipped`);
  for (const m of ps.mismatches) out.push(`  ✗ purchase ${m.purchase}, product ${m.product} @ warehouse ${m.warehouse}: lines say ${bags(m.expectedMilli)}, movements net ${bags(m.netMilli)}`);
  const ac = r.averageCost;
  out.push(
    `Average cost   basis ${ac.basis}: ${n(ac.rows)} stock row(s) recomputed from purchase lines, ${ac.matched} matched, ${ac.mismatches.length} mismatched; ` +
      `${ac.keptFromBefore.length} kept from before (no purchase line — the legacy keeps the old average, informational)`,
  );
  for (const m of ac.mismatches) out.push(`  ✗ product ${m.product} @ warehouse ${m.warehouse}: purchase lines (${m.purchaseLines}) give ${m.recomputedP === null ? "nothing" : n(m.recomputedP)}, stock row says ${n(m.storedP)} paisa`);
  for (const k of ac.keptFromBefore) out.push(`  · kept from before: product ${k.product} @ warehouse ${k.warehouse}, average ${n(k.avgCostP)} paisa`);
  const os = ac.operationalShare;
  out.push(
    `Landed cost    ${n(os.linesChecked)} line(s): operational share = landed-cost rows on ${os.linesChecked - os.mismatches.length}, ${os.mismatches.length} mismatch(es) (${os.withShare} line(s) carry a share); ` +
      `landed unit = goods + charges + operational on ${n(ac.landedUnit.linesChecked)} costed line(s), ${ac.landedUnit.mismatches.length} mismatch(es)`,
  );
  for (const m of os.mismatches) out.push(`  ✗ purchase ${m.purchase}, line ${m.line}: operational share ${n(m.storedP)}, landed-cost rows say ${n(m.landedCostRowsP)}`);
  for (const m of ac.landedUnit.mismatches) out.push(`  ✗ purchase ${m.purchase}, line ${m.line}: landed unit ${n(m.storedP)}, goods + charges + operational give ${n(m.recomputedP)}`);
  if (os.orphanRows.length) out.push(`  note: ${os.orphanRows.length} landed-cost row(s) point at a purchase line that is no longer there (informational)`);
  if (ac.allocation.differs.length) {
    out.push(`  note: ${ac.allocation.differs.length} of ${n(ac.allocation.linesChecked)} line(s) carry a goods unit / charge share that the fixed allocation (part delivery, S11 fix 3) would compute differently (informational)`);
  }
  out.push(`Paper-book     ${r.paperBook.customers} customers and ${r.paperBook.suppliers} suppliers carry a nonzero legacy paper-book figure — deliberately NOT posted (needs an owner-chosen cutover date)`);
  out.push("");
  out.push(r.ok ? "RESULT: PASS — 0 differences" : `RESULT: FAIL — ${r.failures.join("; ")}`);
  return out.join("\n");
}
