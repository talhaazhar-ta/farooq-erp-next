import { eq } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "./schema.js";
import type { Tx } from "./client.js";

/**
 * The single source of truth for how a payment posts to the double-entry ledger. The legacy-backup importer
 * (packages/import) and the live PaymentsService (apps/api) BOTH build their journal lines here, so an imported
 * voucher and one recorded tomorrow are indistinguishable in the journal.
 *
 * A party is carried on the journal LINE (`partyType`/`partyId`), not on the account: a shop's balance is the sum
 * of its lines on RECEIVABLES, a supplier's the sum of its lines on PAYABLES.
 */

export type AccountCode =
  | "CASH"
  | "RECEIVABLES"
  | "PAYABLES"
  | "SALES"
  | "SALES_RETURNS"
  | "PURCHASES"
  | "PURCHASE_RETURNS"
  | "OPENING_EQUITY"
  | "ACCOUNT_ADJUSTMENTS"
  | "MILLING_CLEARING"
  | "MILLING_FEES";

/** Every control account the migrations seed; a missing one means the database was not migrated. */
export const ACCOUNT_CODES: readonly AccountCode[] = [
  "CASH",
  "RECEIVABLES",
  "PAYABLES",
  "SALES",
  "SALES_RETURNS",
  "PURCHASES",
  "PURCHASE_RETURNS",
  "OPENING_EQUITY",
  "ACCOUNT_ADJUSTMENTS",
  "MILLING_CLEARING",
  "MILLING_FEES",
];

export interface JournalLineDraft {
  account: AccountCode;
  partyType?: "CUSTOMER" | "SUPPLIER";
  partyId?: string;
  debitP: number;
  creditP: number;
}

export type PaymentDirection = "IN" | "OUT";
export type PaymentPartyType = "CUSTOMER" | "SUPPLIER";

export const PAYMENT_SOURCE = "PAYMENT";
export const PAYMENT_REVERSAL_SOURCE = "PAYMENT_REVERSAL";

export const plainLine = (account: AccountCode, debitP: number, creditP: number): JournalLineDraft => ({
  account,
  debitP,
  creditP,
});
export const custLine = (partyId: string, debitP: number, creditP: number): JournalLineDraft => ({
  account: "RECEIVABLES",
  partyType: "CUSTOMER",
  partyId,
  debitP,
  creditP,
});
export const supLine = (partyId: string, debitP: number, creditP: number): JournalLineDraft => ({
  account: "PAYABLES",
  partyType: "SUPPLIER",
  partyId,
  debitP,
  creditP,
});

/** The same lines with debit/credit swapped — a reversing entry. */
export function reversedLines(lines: JournalLineDraft[]): JournalLineDraft[] {
  return lines.map((l) => ({ ...l, debitP: l.creditP, creditP: l.debitP }));
}

/**
 * Lines of a payment voucher:
 *   IN  (money from a shop)        DR CASH        / CR RECEIVABLES(shop)
 *   OUT to a CUSTOMER (a refund)   DR RECEIVABLES(shop) / CR CASH
 *   OUT to a SUPPLIER              DR PAYABLES(supplier) / CR CASH
 */
export function paymentLines(p: {
  direction: PaymentDirection;
  partyType: PaymentPartyType;
  partyId: string;
  amountP: number;
}): JournalLineDraft[] {
  if (p.direction === "IN") return [plainLine("CASH", p.amountP, 0), custLine(p.partyId, 0, p.amountP)];
  return p.partyType === "CUSTOMER"
    ? [custLine(p.partyId, p.amountP, 0), plainLine("CASH", 0, p.amountP)]
    : [supLine(p.partyId, p.amountP, 0), plainLine("CASH", 0, p.amountP)];
}

/** Journal memo of a voucher ("Payment received REC-2026-000001"). */
export function paymentMemo(p: { direction: PaymentDirection; partyType: PaymentPartyType; receiptNumber: string }): string {
  const what = p.direction === "IN" ? "Payment received" : p.partyType === "CUSTOMER" ? "Refund paid" : "Payment made";
  return `${what} ${p.receiptNumber}`;
}

export const paymentReversalMemo = (receiptNumber: string): string => `Reversal of ${receiptNumber}`;

/* ── sales invoices (S6) ────────────────────────────────────────────────────
   One entry per posted invoice, `source_type` INVOICE, `source_id` = the invoice id. The legacy Ledger counts every
   invoice whose status is neither DRAFT nor CANCELLED. Until M4 there is NO cost-of-goods / inventory journal: the
   sale is DR RECEIVABLES(shop) / CR SALES for the grand total, and nothing else. */

export const INVOICE_SOURCE = "INVOICE";

/** DR RECEIVABLES(shop) / CR SALES, for the invoice's grand total (never negative). */
export function invoiceLines(customerId: string, totalP: number): JournalLineDraft[] {
  return [custLine(customerId, totalP, 0), plainLine("SALES", 0, totalP)];
}

/** Journal memo of a sale ("Sales invoice INV-2026-000001"); a numberless one is just "Sales invoice". */
export function invoiceMemo(invoiceNumber: string | null | undefined): string {
  return `Sales invoice ${invoiceNumber ?? ""}`.trim();
}

/** A cancelled invoice keeps its INVOICE entry and gets this one, dated the invoice's own date, so the pair cancels at every date (S7 decision 1; same rule as PAYMENT_REVERSAL). */
export const INVOICE_CANCEL_SOURCE = "INVOICE_CANCEL";

/** The mirror image of `invoiceLines` — CR RECEIVABLES(shop) / DR SALES. */
export function invoiceCancelLines(customerId: string, totalP: number): JournalLineDraft[] {
  return reversedLines(invoiceLines(customerId, totalP));
}

export const invoiceCancelMemo = (invoiceNumber: string | null | undefined): string => `Cancelled sales invoice ${invoiceNumber ?? ""}`.trim();

/** Whether an invoice with this status is in the ledger (legacy `Ledger`: everything except DRAFT and CANCELLED). */
export const invoicePosts = (status: string): boolean => status !== "DRAFT" && status !== "CANCELLED";

/* ── supplier purchases (S11) ───────────────────────────────────────────────
   One entry per purchase that is in the ledger, `source_type` PURCHASE, `source_id` = the purchase id. The legacy Ledger counts
   every purchase that is not CANCELLED - a DRAFT (and an ORDERED one, nothing received yet) DOES post. Until M4 there is no
   inventory journal: the bill is DR PURCHASES / CR PAYABLES(supplier) for the grand total, and nothing else. */

export const PURCHASE_SOURCE = "PURCHASE";

/** DR PURCHASES / CR PAYABLES(supplier), for the purchase's grand total; a negative total swaps the sides (the same signed effect). */
export function purchaseLines(supplierId: string, totalP: number): JournalLineDraft[] {
  const abs = Math.abs(totalP);
  return totalP >= 0 ? [plainLine("PURCHASES", abs, 0), supLine(supplierId, 0, abs)] : [supLine(supplierId, abs, 0), plainLine("PURCHASES", 0, abs)];
}

/** Journal memo of a purchase ("Purchase PUR-2026-000001"); a numberless one is just "Purchase". */
export function purchaseMemo(purchaseNumber: string | null | undefined): string {
  return `Purchase ${purchaseNumber ?? ""}`.trim();
}

/** Whether a purchase with this status is in the ledger (legacy `Ledger`: everything except CANCELLED - DRAFT counts). */
export const purchasePosts = (status: string): boolean => status !== "CANCELLED";

/** Resolves control-account codes to ids (`accounts.code` is unique). Throws if the database was not migrated. */
export async function loadAccountIds(tx: Tx): Promise<Map<AccountCode, string>> {
  const rows = await tx.select({ id: accounts.id, code: accounts.code }).from(accounts);
  const byCode = new Map(rows.map((a) => [a.code as AccountCode, a.id]));
  const missing = ACCOUNT_CODES.filter((c) => !byCode.has(c));
  if (missing.length) throw new Error(`Control accounts missing (${missing.join(", ")}) — run the migrations.`);
  return byCode;
}

export interface PostEntryInput {
  date: string;
  memo: string;
  sourceType: string;
  sourceId: string;
  createdBy: string | null;
  lines: JournalLineDraft[];
}

/**
 * Inserts one journal entry and its lines inside the caller's transaction. Exactly one entry may exist per
 * (source_type, source_id) — the unique index enforces it — and the deferred S1 trigger refuses to commit an entry
 * whose lines do not balance.
 */
export async function postJournalEntry(tx: Tx, accountIds: Map<AccountCode, string>, entry: PostEntryInput): Promise<string> {
  const [row] = await tx
    .insert(journalEntries)
    .values({
      date: entry.date,
      memo: entry.memo,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      createdBy: entry.createdBy,
    })
    .returning({ id: journalEntries.id });
  await insertLines(tx, accountIds, row!.id, entry.lines);
  return row!.id;
}

/** Replaces the lines of an existing entry (the `editAmount` correction: one entry, new figures). */
export async function replaceEntryLines(tx: Tx, accountIds: Map<AccountCode, string>, entryId: string, lines: JournalLineDraft[]): Promise<void> {
  await tx.delete(journalLines).where(eq(journalLines.entryId, entryId));
  await insertLines(tx, accountIds, entryId, lines);
}

/** Moves an existing entry to another business date (the invoice edit: the legacy ledger reads `invoiceDate` live). */
export async function setEntryDate(tx: Tx, entryId: string, date: string): Promise<void> {
  await tx.update(journalEntries).set({ date }).where(eq(journalEntries.id, entryId));
}

async function insertLines(tx: Tx, accountIds: Map<AccountCode, string>, entryId: string, lines: JournalLineDraft[]): Promise<void> {
  await tx.insert(journalLines).values(
    lines.map((l) => ({
      entryId,
      accountId: accountIds.get(l.account)!,
      partyType: l.partyType ?? null,
      partyId: l.partyId ?? null,
      debitP: l.debitP,
      creditP: l.creditP,
    })),
  );
}
