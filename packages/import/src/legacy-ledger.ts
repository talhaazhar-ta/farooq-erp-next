/**
 * LegacyLedger — an independent, literal TypeScript port of the old app's *effective* customer/supplier
 * ledger, run on the raw backup JSON in memory.
 *
 * Independence is the whole point (CLAUDE.md rule 8): this file imports nothing from the importer, the
 * journal poster or the database, so the reconciliation compares two implementations built differently.
 *
 * "Effective" matters: `Ledger.customer` / `Ledger.supplier` in 02-services.js (lines 1742-1824) are
 * *wrapped* by two later patch modules, and the wrapped versions are what every screen shows:
 *   - 16-khata.js  wraps Ledger.customer: adds `accountAdjustments` rows and re-sorts with the OPENING
 *                  row always first, whatever its date.
 *   - 32-milling.js wraps Ledger.supplier: adds three row kinds per non-cancelled milling job.
 *   - 24-client-changes.js also wraps both but only decorates row descriptions — balances untouched.
 * Quirks are reproduced on purpose, not "fixed" (see the comments at each one).
 *
 * Sign convention: customer balance positive = the shop owes us; supplier balance positive = we owe them.
 */

type Doc = Record<string, any>;  // raw legacy JSON
export type LegacyData = Record<string, Doc[] | undefined>;

export interface LedgerRow {
  iso: string;
  ref: string;
  what: string;
  dr: number;
  cr: number;
  kind: "INVOICE" | "PAYMENT" | "REFUND" | "RETURN" | "OPENING" | "PURCHASE" | "ADJUSTMENT" | "MILLING";
  id: string;
  /** Absent on refund / supplier-payment / return / opening rows — those sort first within a day. */
  createdAt?: string;
  balance?: number;
}

export interface LedgerResult {
  opening: number;
  rows: LedgerRow[];
  closing: number;
  debit: number;
  credit: number;
}

/** `Ledger._roll`. `rows` is sorted in place, exactly as the original does. */
function roll(rows: LedgerRow[], fromISO: string | null | undefined, toISO: string | null | undefined, credited: boolean): LedgerResult {
  // Business date first; for two entries on the same day, the order they were entered (createdAt).
  // Array.prototype.sort is stable, so equal keys keep insertion order, like the browser's.
  rows.sort((a, b) => {
    if (a.iso !== b.iso) return a.iso < b.iso ? -1 : 1;
    const ac = a.createdAt || "";
    const bc = b.createdAt || "";
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  });
  let bal = 0;
  let opening = 0;
  const out: LedgerRow[] = [];
  for (const r of rows) {
    const delta = credited ? r.cr - r.dr : r.dr - r.cr;
    if (toISO && r.iso > toISO) continue; // after the period: not part of the statement
    if (fromISO && r.iso < fromISO) {
      bal += delta;
      opening = bal;
      continue;
    }
    bal += delta;
    out.push({ ...r, balance: bal });
  }
  return {
    opening,
    rows: out,
    closing: bal,
    debit: out.reduce((a, r) => a + r.dr, 0),
    credit: out.reduce((a, r) => a + r.cr, 0),
  };
}

function stripBalance(r: LedgerRow): LedgerRow {
  const copy = { ...r };
  delete copy.balance;
  return copy;
}

function groupBy(docs: Doc[], key: string): Map<string, Doc[]> {
  const m = new Map<string, Doc[]>();
  for (const d of docs) {
    const k = d[key];
    if (typeof k !== "string") continue;
    const list = m.get(k);
    if (list) list.push(d);
    else m.set(k, [d]);
  }
  return m;
}

export interface LegacyLedger {
  customerIds: string[];
  supplierIds: string[];
  customer(customerId: string, fromISO?: string | null, toISO?: string | null): LedgerResult;
  supplier(supplierId: string, fromISO?: string | null, toISO?: string | null): LedgerResult;
  /** Paper-book figures deliberately not posted: parties with any nonzero legacyTotalSales / Collection / BalanceSigned. */
  paperBookParties(): { customers: number; suppliers: number };
}

export function createLegacyLedger(data: LegacyData): LegacyLedger {
  const customers = data.customers ?? [];
  const suppliers = data.suppliers ?? [];
  const customerById = new Map(customers.map((c) => [c.id as string, c]));
  const supplierById = new Map(suppliers.map((s) => [s.id as string, s]));

  const invoicesBy = groupBy(data.invoices ?? [], "customerId");
  const paymentsBy = groupBy(data.payments ?? [], "partyId");
  const custReturnsBy = groupBy(data.customerReturns ?? [], "customerId");
  const adjustmentsBy = groupBy(data.accountAdjustments ?? [], "customerId");
  const purchasesBy = groupBy(data.purchases ?? [], "supplierId");
  const supReturnsBy = groupBy(data.supplierReturns ?? [], "supplierId");
  const millingBy = groupBy(data.millingJobs ?? [], "millId");

  /** Base `Ledger.customer`, unbounded (16-khata.js always asks the original for the full history). */
  function baseCustomerRows(customerId: string): LedgerRow[] {
    const rows: LedgerRow[] = [];
    for (const i of invoicesBy.get(customerId) ?? []) {
      if (i.status === "DRAFT" || i.status === "CANCELLED") continue;
      rows.push({ iso: i.invoiceDate, ref: i.invoiceNumber, what: "Sales invoice", dr: i.grandTotal, cr: 0, kind: "INVOICE", id: i.id, createdAt: i.createdAt });
    }
    for (const p of paymentsBy.get(customerId) ?? []) {
      // The filter is `direction === 'IN' || partyType === 'CUSTOMER'` — an OUT payment to a CUSTOMER is a refund.
      if (p.status === "REVERSED") continue;
      if (!(p.direction === "IN" || p.partyType === "CUSTOMER")) continue;
      if (p.direction === "IN") {
        rows.push({ iso: p.paymentDate, ref: p.receiptNumber, what: `Payment received — ${p.method}`, dr: 0, cr: p.amount, kind: "PAYMENT", id: p.id, createdAt: p.createdAt });
      } else {
        // Quirk: refund rows carry no createdAt, so within a day they sort before everything that has one.
        rows.push({ iso: p.paymentDate, ref: p.receiptNumber, what: `Refund paid — ${p.method}`, dr: p.amount, cr: 0, kind: "REFUND", id: p.id });
      }
    }
    for (const r of custReturnsBy.get(customerId) ?? []) {
      // Quirk: only CANCELLED is excluded — a DRAFT return already counts as a credit note.
      if (r.status === "CANCELLED") continue;
      rows.push({ iso: r.returnDate, ref: r.returnNumber, what: "Credit note — return", dr: 0, cr: r.creditAmount, kind: "RETURN", id: r.id, createdAt: r.createdAt });
    }
    const c = customerById.get(customerId);
    if (c && c.openingBalanceP) {
      rows.push({ iso: c.openingBalanceDate || "2000-01-01", ref: "OPENING", what: "Opening balance", dr: c.openingBalanceP, cr: 0, kind: "OPENING", id: "opening" });
    }
    return rows;
  }

  /** Base `Ledger.supplier`, unbounded. */
  function baseSupplierRows(supplierId: string): LedgerRow[] {
    const rows: LedgerRow[] = [];
    for (const p of purchasesBy.get(supplierId) ?? []) {
      // Quirk: DRAFT purchases count; only CANCELLED is excluded.
      if (p.status === "CANCELLED") continue;
      rows.push({ iso: p.purchaseDate, ref: p.purchaseNumber, what: "Purchase invoice", dr: 0, cr: p.grandTotal, kind: "PURCHASE", id: p.id, createdAt: p.createdAt });
    }
    for (const p of paymentsBy.get(supplierId) ?? []) {
      if (!(p.direction === "OUT" && p.partyType !== "CUSTOMER" && p.status !== "REVERSED")) continue;
      // Quirk: supplier payment rows carry no createdAt.
      rows.push({ iso: p.paymentDate, ref: p.receiptNumber, what: `Payment made — ${p.method}`, dr: p.amount, cr: 0, kind: "PAYMENT", id: p.id });
    }
    for (const r of supReturnsBy.get(supplierId) ?? []) {
      if (r.status === "CANCELLED") continue;
      rows.push({ iso: r.returnDate, ref: r.returnNumber, what: "Return to supplier", dr: r.debitAmount, cr: 0, kind: "RETURN", id: r.id });
    }
    const s = supplierById.get(supplierId);
    if (s && s.openingBalanceP) {
      rows.push({ iso: s.openingBalanceDate || "2000-01-01", ref: "OPENING", what: "Opening balance", dr: 0, cr: s.openingBalanceP, kind: "OPENING", id: "opening" });
    }
    return rows;
  }

  function customer(customerId: string, fromISO?: string | null, toISO?: string | null): LedgerResult {
    // Step 1 (02-services.js): the original returns its rows already sorted by _roll (unbounded).
    const rows = roll(baseCustomerRows(customerId), null, null, false).rows.map(stripBalance);
    // Step 2 (16-khata.js): append adjustments, re-sort with OPENING first, then window and sum.
    for (const a of adjustmentsBy.get(customerId) ?? []) {
      if (a.status === "REVERSED") continue;
      rows.push({
        iso: a.adjustmentDate,
        ref: a.adjustmentNumber,
        what: `Adjustment — ${a.reason}`,
        dr: a.direction === "DEBIT" ? a.amount : 0,
        cr: a.direction === "CREDIT" ? a.amount : 0,
        kind: "ADJUSTMENT",
        id: a.id,
        createdAt: a.createdAt,
      });
    }
    rows.sort((a, b) => {
      // Quirk: the OPENING row is always first, even when its date is later than other rows'.
      if (a.kind === "OPENING") return -1;
      if (b.kind === "OPENING") return 1;
      if (a.iso !== b.iso) return a.iso < b.iso ? -1 : 1;
      const ac = a.createdAt || "";
      const bc = b.createdAt || "";
      return ac < bc ? -1 : ac > bc ? 1 : 0;
    });
    let bal = 0;
    let opening = 0;
    const out: LedgerRow[] = [];
    for (const r of rows) {
      const delta = r.dr - r.cr;
      if (fromISO && r.iso < fromISO) {
        bal += delta;
        opening = bal;
        continue;
      }
      if (toISO && r.iso > toISO) continue;
      bal += delta;
      out.push({ ...r, balance: bal });
    }
    return {
      opening,
      rows: out,
      closing: bal,
      debit: out.reduce((a, r) => a + r.dr, 0),
      credit: out.reduce((a, r) => a + r.cr, 0),
    };
  }

  function supplier(supplierId: string, fromISO?: string | null, toISO?: string | null): LedgerResult {
    // Step 1 (02-services.js): base rows, rolled unbounded with credited=true.
    const full = roll(baseSupplierRows(supplierId), null, null, true);
    const rows = full.rows.map(stripBalance);
    // Step 2 (32-milling.js): three row kinds per non-cancelled job, then re-roll with the caller's window.
    for (const j of millingBy.get(supplierId) ?? []) {
      if (j.status === "CANCELLED") continue;
      // Quirk: FEE_ONLY jobs post the fee only — issued/received values are ignored even if nonzero.
      // Quirk: the `#1/#2/#3` suffix on createdAt orders the three rows of one job after its plain createdAt.
      if (j.settle !== "FEE_ONLY") {
        if (j.issuedValue) rows.push({ iso: j.jobDate, ref: j.jobNumber, what: "Wheat issued — milling job", dr: j.issuedValue, cr: 0, kind: "MILLING", id: `${j.id}#issue`, createdAt: `${j.createdAt || ""}#1` });
        if (j.receivedValue) rows.push({ iso: j.jobDate, ref: j.jobNumber, what: "Received from mill — milling job", dr: 0, cr: j.receivedValue, kind: "MILLING", id: `${j.id}#recv`, createdAt: `${j.createdAt || ""}#2` });
      }
      if (j.feeAmount) rows.push({ iso: j.jobDate, ref: j.jobNumber, what: "Milling fee", dr: 0, cr: j.feeAmount, kind: "MILLING", id: `${j.id}#fee`, createdAt: `${j.createdAt || ""}#3` });
    }
    return roll(rows, fromISO, toISO, true);
  }

  const isNonzero = (v: unknown) => typeof v === "number" && v !== 0;
  return {
    customerIds: customers.map((c) => c.id as string),
    supplierIds: suppliers.map((s) => s.id as string),
    customer,
    supplier,
    paperBookParties: () => {
      const has = (d: Doc) => isNonzero(d.legacyTotalSales) || isNonzero(d.legacyTotalCollection) || isNonzero(d.legacyBalanceSigned);
      return { customers: customers.filter(has).length, suppliers: suppliers.filter(has).length };
    },
  };
}
