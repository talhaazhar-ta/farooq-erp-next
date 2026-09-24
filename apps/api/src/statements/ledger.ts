import { sql } from "drizzle-orm";
import type { Executor } from "@farooq/db";
import type { Statement, StatementRow, StatementRowKind } from "@farooq/shared";

/**
 * A party's account statement, built from the JOURNAL (party lines on RECEIVABLES / PAYABLES joined to the source
 * document for its number and method). One implementation for the statement endpoints and for the receipt's
 * previous / remaining balance, so a receipt and the statement always agree.
 *
 * Decisions (S4 plan, recorded in STATUS):
 *  1. Order: business date → journal created_at → entry id. For CUSTOMERS the OPENING row comes first whatever its date
 *     (the legacy 16-khata.js does); for suppliers it comes first within its own date (the legacy gave a supplier's
 *     opening no createdAt, so it sorted first in its day). The legacy quirk that refunds / supplier payments / returns
 *     — rows without a createdAt on the legacy ledger row — sort before same-day invoices is NOT copied: it is an
 *     artefact of missing data, not intent. Closing and end-of-day balances are identical either way.
 *  2. A REVERSED payment / adjustment is omitted with its reversal entry (the legacy statement never shows it);
 *     `omittedReversed` says how many. An edited voucher is one row at its current amount.
 *  2b. (S7) A CANCELLED invoice is omitted with its INVOICE_CANCEL entry, the same way — the legacy ledger skipped a
 *     CANCELLED invoice; `omittedCancelled` counts them. The pair nets to zero at every date, so no balance moves.
 *
 * The wording of the descriptions is the legacy `Ledger`'s (02-services.js, 16-khata.js, 32-milling.js). NOT ported: the
 * display-time decoration of 24-client-changes.js (a typed "Description / تفصیل", the auto text "Cash received against
 * outstanding balance", invoice line summaries) — it needs invoice items (M2) and is a presentation choice for S5.
 */

export type PartyType = "CUSTOMER" | "SUPPLIER";

type RawLine = {
  entry_id: string;
  date: string;
  created_at: Date | string;
  source_type: string | null;
  source_id: string | null;
  memo: string | null;
  debit: string;
  credit: string;
  invoice_number: string | null;
  invoice_status: string | null;
  purchase_number: string | null;
  receipt_number: string | null;
  pay_direction: string | null;
  pay_party_type: string | null;
  pay_method: string | null;
  pay_status: string | null;
  return_number: string | null;
  adjustment_number: string | null;
  adj_reason: string | null;
  adj_status: string | null;
  job_number: string | null;
};

/** One statement row before windowing, plus what the receipt / omission logic needs. */
export interface LedgerEntry {
  entryId: string;
  date: string;
  createdAt: Date;
  kind: StatementRowKind;
  ref: string;
  description: string;
  debitP: number;
  creditP: number;
  sourceType: string;
  sourceId: string;
  isOpening: boolean;
}

export interface FullLedger {
  /** Ordered, reversed vouchers already left out. */
  entries: LedgerEntry[];
  /** Dates of the reversed vouchers that were left out (one per voucher). */
  omittedReversedDates: string[];
  /** Dates of the cancelled invoices that were left out (one per invoice). */
  omittedCancelledDates: string[];
}

const withMethod = (label: string, method: string | null): string => (method ? `${label} — ${method}` : label);

interface Classified {
  kind: StatementRowKind;
  ref: string;
  description: string;
  omit: boolean;
  isOpening: boolean;
  countsAsOmittedVoucher: boolean;
  countsAsOmittedCancelled?: boolean;
}

function classify(r: RawLine): Classified {
  const t = r.source_type ?? "";
  const row = (kind: StatementRowKind, ref: string | null, description: string): Classified => ({
    kind, ref: ref ?? "", description, omit: false, isOpening: false, countsAsOmittedVoucher: false,
  });
  switch (t) {
    case "INVOICE":
      if (r.invoice_status === "CANCELLED") return { ...row("INVOICE", r.invoice_number, ""), omit: true, countsAsOmittedCancelled: true };
      return row("INVOICE", r.invoice_number, "Sales invoice");
    case "INVOICE_CANCEL":
      return { ...row("OTHER", null, ""), omit: true };
    case "PURCHASE":
      return row("PURCHASE", r.purchase_number, "Purchase invoice");
    case "PAYMENT": {
      if (r.pay_status === "REVERSED") return { ...row("PAYMENT", r.receipt_number, ""), omit: true, countsAsOmittedVoucher: true };
      if (r.pay_direction === "IN") return row("PAYMENT", r.receipt_number, withMethod("Payment received", r.pay_method));
      if (r.pay_party_type === "CUSTOMER") return row("REFUND", r.receipt_number, withMethod("Refund paid", r.pay_method));
      return row("PAYMENT", r.receipt_number, withMethod("Payment made", r.pay_method));
    }
    case "PAYMENT_REVERSAL":
    case "ADJUSTMENT_REVERSAL":
      return { ...row("OTHER", null, ""), omit: true };
    case "CUSTOMER_RETURN":
      return row("RETURN", r.return_number, "Credit note — return");
    case "SUPPLIER_RETURN":
      return row("RETURN", r.return_number, "Return to supplier");
    case "CUSTOMER_OPENING":
    case "SUPPLIER_OPENING":
      return { ...row("OPENING", "OPENING", "Opening balance"), isOpening: true };
    case "ADJUSTMENT": {
      if (r.adj_status === "REVERSED") return { ...row("ADJUSTMENT", r.adjustment_number, ""), omit: true, countsAsOmittedVoucher: true };
      return row("ADJUSTMENT", r.adjustment_number, r.adj_reason ? `Adjustment — ${r.adj_reason}` : "Adjustment");
    }
    case "MILLING_ISSUE":
      return row("MILLING", r.job_number, "Wheat issued — milling job");
    case "MILLING_RECEIVED":
      return row("MILLING", r.job_number, "Received from mill — milling job");
    case "MILLING_FEE":
      return row("MILLING", r.job_number, "Milling fee");
    default:
      // a document type a later module posts: shown by its journal memo rather than hidden
      return row("OTHER", null, r.memo ?? t);
  }
}

/** The party's whole ledger, ordered, with reversed vouchers left out. */
export async function loadFullLedger(db: Executor, partyType: PartyType, partyId: string): Promise<FullLedger> {
  const account = partyType === "CUSTOMER" ? "RECEIVABLES" : "PAYABLES";
  const lines = await db.execute<RawLine>(sql`
    SELECT e.id AS entry_id, e.date::text AS date, e.created_at, e.source_type, e.source_id::text AS source_id, e.memo,
           l.debit_p::text AS debit, l.credit_p::text AS credit,
           inv.invoice_number, inv.status AS invoice_status, pur.purchase_number, pay.receipt_number, pay.direction AS pay_direction,
           pay.party_type AS pay_party_type, pay.method AS pay_method, pay.status AS pay_status,
           ret.return_number, adj.adjustment_number, adj.reason AS adj_reason, adj.status AS adj_status, mj.job_number
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id AND a.code = ${account}
    JOIN journal_entries e ON e.id = l.entry_id
    LEFT JOIN invoices inv ON e.source_type IN ('INVOICE', 'INVOICE_CANCEL') AND inv.id = e.source_id
    LEFT JOIN purchases pur ON e.source_type = 'PURCHASE' AND pur.id = e.source_id
    LEFT JOIN payments pay ON e.source_type IN ('PAYMENT', 'PAYMENT_REVERSAL') AND pay.id = e.source_id
    LEFT JOIN returns ret ON e.source_type IN ('CUSTOMER_RETURN', 'SUPPLIER_RETURN') AND ret.id = e.source_id
    LEFT JOIN account_adjustments adj ON e.source_type IN ('ADJUSTMENT', 'ADJUSTMENT_REVERSAL') AND adj.id = e.source_id
    LEFT JOIN milling_jobs mj ON e.source_type IN ('MILLING_ISSUE', 'MILLING_RECEIVED', 'MILLING_FEE') AND mj.id = e.source_id
    WHERE l.party_type = ${partyType} AND l.party_id = ${partyId}`);

  const byEntry = new Map<string, LedgerEntry>();
  const omittedReversedDates: string[] = [];
  const omittedCancelledDates: string[] = [];
  for (const r of lines) {
    const c = classify(r);
    if (c.omit) {
      if (c.countsAsOmittedVoucher) omittedReversedDates.push(r.date);
      if (c.countsAsOmittedCancelled) omittedCancelledDates.push(r.date);
      continue;
    }
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    const known = byEntry.get(r.entry_id);
    if (known) {
      known.debitP += debit; // an entry with two lines on the same party: one row
      known.creditP += credit;
      continue;
    }
    byEntry.set(r.entry_id, {
      entryId: r.entry_id,
      date: r.date,
      createdAt: new Date(r.created_at),
      kind: c.kind,
      ref: c.ref,
      description: c.description,
      debitP: debit,
      creditP: credit,
      sourceType: r.source_type ?? "",
      sourceId: r.source_id ?? r.entry_id,
      isOpening: c.isOpening,
    });
  }
  const isCustomer = partyType === "CUSTOMER";
  const entries = [...byEntry.values()].sort((a, b) => {
    if (isCustomer && a.isOpening !== b.isOpening) return a.isOpening ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (!isCustomer && a.isOpening !== b.isOpening) return a.isOpening ? -1 : 1; // a supplier's opening leads its own day
    const at = a.createdAt.getTime();
    const bt = b.createdAt.getTime();
    if (at !== bt) return at - bt;
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
  });
  return { entries, omittedReversedDates, omittedCancelledDates };
}

/** Customers: debit − credit (positive = the shop owes us). Suppliers: credit − debit (positive = we owe them). */
export const deltaOf = (partyType: PartyType, e: { debitP: number; creditP: number }): number =>
  partyType === "CUSTOMER" ? e.debitP - e.creditP : e.creditP - e.debitP;

export interface StatementWindow {
  from: string | null;
  to: string | null;
}

/**
 * Windows a full ledger: entries dated before `from` make up the opening balance (a sum, so their listing order cannot
 * matter), entries after `to` are left out, and the running balance of the rows starts from the opening balance —
 * so `opening + Σ rows = closing` always, even for a customer whose OPENING row is listed first but dated later than
 * transactions before `from` (there the legacy's own opening figure was inconsistent with its rows).
 */
export function windowStatement(partyType: PartyType, ledger: FullLedger, w: StatementWindow): Omit<Statement, "party"> {
  const opening = w.from ? ledger.entries.filter((e) => e.date < w.from!).reduce((a, e) => a + deltaOf(partyType, e), 0) : 0;
  let balance = opening;
  let debitP = 0;
  let creditP = 0;
  const rows: StatementRow[] = [];
  for (const e of ledger.entries) {
    if (w.from && e.date < w.from) continue;
    if (w.to && e.date > w.to) continue;
    balance += deltaOf(partyType, e);
    debitP += e.debitP;
    creditP += e.creditP;
    rows.push({
      date: e.date,
      createdAt: e.createdAt.toISOString(),
      kind: e.kind,
      ref: e.ref,
      description: e.description,
      debitP: e.debitP,
      creditP: e.creditP,
      balanceP: balance,
      source: { type: e.sourceType, id: e.sourceId },
      // (S8) filled in for invoice rows by the statement query, which reads the lines
      detail: null,
      qtyInfo: null,
      qtyLabel: "—",
    });
  }
  const omitted = ledger.omittedReversedDates.filter((d) => (!w.from || d >= w.from) && (!w.to || d <= w.to)).length;
  const omittedCancelled = ledger.omittedCancelledDates.filter((d) => (!w.from || d >= w.from) && (!w.to || d <= w.to)).length;
  return { from: w.from, to: w.to, opening, rows, totals: { debitP, creditP }, closing: balance, omittedReversed: omitted, omittedCancelled };
}
