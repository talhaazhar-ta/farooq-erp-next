import { formatPaisa, parseRupees } from "@farooq/shared";

/**
 * The Receive panel's allocation logic. The SERVER stays the judge (it re-checks everything); these functions only
 * decide what the screen previews and whether Save is offered. The auto rule is the server's: walk the invoices in the
 * order the server listed them (oldest first — `GET …/outstanding-invoices` already sorts them by date, entry time,
 * number, id), give each `min(outstanding, money left)`, stop when the money runs out; the rest stays on account.
 */

export interface OutstandingLike {
  id: string;
  outstandingP: number;
}
export interface AllocationLine {
  invoiceId: string;
  amountP: number;
}

export function autoAllocate(outstanding: readonly OutstandingLike[], amountP: number): { lines: AllocationLine[]; leftOverP: number } {
  let left = Math.max(0, Math.trunc(amountP));
  const lines: AllocationLine[] = [];
  for (const row of outstanding) {
    if (left <= 0) break;
    if (row.outstandingP <= 0) continue;
    const take = Math.min(row.outstandingP, left);
    lines.push({ invoiceId: row.id, amountP: take });
    left -= take;
  }
  return { lines, leftOverP: left };
}

export interface ManualResult {
  lines: AllocationLine[];
  totalP: number;
  /** Money received that no invoice takes → on account. */
  leftOverP: number;
  /** Per-invoice message for a box that is not a valid amount or is above what the invoice still owes. */
  rowErrors: Record<string, string>;
  /** Set when the boxes together are more than the amount received. */
  totalError: string | null;
}

/** `entries` are the rupee texts typed in each invoice's box (blank = nothing for that invoice). */
export function manualAllocation(outstanding: readonly OutstandingLike[], entries: Readonly<Record<string, string>>, amountP: number): ManualResult {
  const lines: AllocationLine[] = [];
  const rowErrors: Record<string, string> = {};
  let totalP = 0;
  for (const row of outstanding) {
    const text = (entries[row.id] ?? "").trim();
    if (!text) continue;
    const r = parseRupees(text);
    if (!r.ok) {
      rowErrors[row.id] = r.message;
      continue;
    }
    if (r.paisa === 0) continue;
    if (r.paisa > row.outstandingP) {
      rowErrors[row.id] = `More than the ${formatPaisa(Math.max(0, row.outstandingP))} outstanding.`;
      continue;
    }
    lines.push({ invoiceId: row.id, amountP: r.paisa });
    totalP += r.paisa;
  }
  const totalError = totalP > amountP ? `The invoices add up to ${formatPaisa(totalP)}, more than the ${formatPaisa(amountP)} received.` : null;
  return { lines, totalP, leftOverP: Math.max(0, amountP - totalP), rowErrors, totalError };
}

export const hasManualProblems = (m: ManualResult): boolean => Object.keys(m.rowErrors).length > 0 || m.totalError !== null;

/** How much a "Fill" button puts in one invoice's box: what it owes, or what is left of the money, whichever is less. */
export function fillAmount(row: OutstandingLike, receivedP: number, enteredElsewhereP: number): number {
  return Math.max(0, Math.min(row.outstandingP, receivedP - enteredElsewhereP));
}
