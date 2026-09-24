import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { invoiceItems, paymentAllocations, payments, returns, type Executor } from "@farooq/db";
import { formatMoney, INVOICE_MESSAGES } from "@farooq/shared";

/**
 * What stops an invoice from being edited, cancelled or moved — one place, used by the service (under the invoice's lock)
 * and by the read model's `actions` (so the screen can show a disabled button with the server's own reason).
 * Every function returns the refusal text, or `null` when the action is allowed as far as the data goes; permissions are checked separately.
 */

export interface InvoiceForRules {
  id: string;
  status: string;
  customerId: string | null;
  number: string | null;
  shopNameSnapshot: string | null;
  dispatchNumber: string | null;
  totalP: number;
}

/** Statuses the legacy sets when goods come back. */
const RETURN_STATUSES = ["RETURNED", "PARTIALLY_RETURNED"];

/** Non-cancelled customer returns against the invoice (numbers, for the message). */
export async function activeReturns(db: Executor, invoiceId: string): Promise<{ id: string; number: string | null }[]> {
  const rows = await db
    .select({ id: returns.id, number: returns.returnNumber })
    .from(returns)
    .where(and(eq(returns.invoiceId, invoiceId), eq(returns.kind, "CUSTOMER"), sql`${returns.status} <> 'CANCELLED'`))
    .orderBy(asc(returns.date), asc(returns.id));
  return rows;
}

/** True when any bag of the invoice has been returned (a line's returned quantity, a return row, or the return statuses). */
export async function hasReturns(db: Executor, inv: InvoiceForRules): Promise<{ has: boolean; numbers: string[] }> {
  const rets = await activeReturns(db, inv.id);
  const [line] = await db
    .select({ n: sql<string>`COUNT(*)::text` })
    .from(invoiceItems)
    .where(and(eq(invoiceItems.invoiceId, inv.id), sql`${invoiceItems.returnedQtyMilli} > 0`));
  const has = rets.length > 0 || Number(line?.n ?? 0) > 0 || RETURN_STATUSES.includes(inv.status);
  return { has, numbers: rets.map((r) => r.number ?? "(no number)") };
}

/** A dispatch note exists (module 30 is M4; until then: the imported `dispatchNumber`, or the DISPATCHED status). */
export const hasDispatch = (inv: Pick<InvoiceForRules, "status" | "dispatchNumber">): boolean =>
  inv.status === "DISPATCHED" || (inv.dispatchNumber !== null && inv.dispatchNumber.trim() !== "");

export interface ReceiptOnInvoice {
  paymentId: string;
  receiptNumber: string;
  amountP: number;
  status: string;
  date: string;
  /** Every allocation of this receipt goes to this invoice and together they equal the receipt (the legacy "wholly applied"). */
  wholly: boolean;
  allocatedToThisP: number;
}

/** Every voucher with an allocation to this invoice, with whether it belongs to it wholly (legacy `reassignCheck`). */
export async function receiptsOn(db: Executor, invoiceId: string): Promise<ReceiptOnInvoice[]> {
  const mine = await db
    .select({ paymentId: paymentAllocations.paymentId, amountP: paymentAllocations.amountP })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.invoiceId, invoiceId));
  const ids = [...new Set(mine.map((a) => a.paymentId))];
  if (ids.length === 0) return [];
  const pays = await db
    .select({ id: payments.id, receiptNumber: payments.receiptNumber, amountP: payments.amountP, status: payments.status, date: payments.paymentDate, createdAt: payments.createdAt })
    .from(payments)
    .where(inArray(payments.id, ids));
  const all = await db.select({ paymentId: paymentAllocations.paymentId, invoiceId: paymentAllocations.invoiceId, amountP: paymentAllocations.amountP }).from(paymentAllocations).where(inArray(paymentAllocations.paymentId, ids));
  return pays
    .map((p) => {
      const rows = all.filter((a) => a.paymentId === p.id);
      return {
        paymentId: p.id,
        receiptNumber: p.receiptNumber,
        amountP: p.amountP,
        status: p.status,
        date: p.date,
        createdAt: p.createdAt,
        wholly: rows.every((a) => a.invoiceId === invoiceId) && rows.reduce((s, a) => s + a.amountP, 0) === p.amountP,
        allocatedToThisP: mine.filter((a) => a.paymentId === p.id).reduce((s, a) => s + a.amountP, 0),
      };
    })
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.createdAt.getTime() - b.createdAt.getTime()))
    .map(({ createdAt: _createdAt, ...rest }) => rest);
}

const isPosted = (inv: Pick<InvoiceForRules, "status">): boolean => inv.status !== "DRAFT" && inv.status !== "CANCELLED";

/** Editing an invoice that is already posted (a draft has no such refusals). */
export async function editRefusal(db: Executor, inv: InvoiceForRules): Promise<string | null> {
  if (inv.status === "CANCELLED") return INVOICE_MESSAGES.cancelledEdit;
  if (inv.status === "DRAFT") return null;
  const ret = await hasReturns(db, inv);
  if (ret.has) {
    return (
      `A return has been posted against this invoice${ret.numbers.length ? ` (${ret.numbers.join(", ")})` : ""}, so it can no longer be edited: ` +
      "the bags and the shop's balance have already moved for it. Make a new invoice for the change instead."
    );
  }
  if (hasDispatch(inv)) {
    return (
      `This invoice has been dispatched${inv.dispatchNumber ? ` (dispatch note ${inv.dispatchNumber})` : ""}, so it can no longer be edited. ` +
      "Duplicate it and make a new invoice for the change instead."
    );
  }
  return null;
}

/** Cancelling: refused with a return against it, and (owner decision 1) while money received against it is still standing. */
export async function cancelRefusal(db: Executor, inv: InvoiceForRules): Promise<string | null> {
  if (inv.status === "CANCELLED") return INVOICE_MESSAGES.alreadyCancelled;
  if (inv.status === "DRAFT") return null;
  const ret = await hasReturns(db, inv);
  if (ret.has) {
    return (
      `A return has been posted against this invoice${ret.numbers.length ? ` (${ret.numbers.join(", ")})` : ""}, so it cannot be cancelled: ` +
      "the returned bags are already back in stock. Reverse the return first."
    );
  }
  const received = (await receiptsOn(db, inv.id)).filter((r) => r.status === "POSTED");
  if (received.length) {
    return (
      `Money has been received against this invoice (${received.map((r) => `${r.receiptNumber} — ${formatMoney(r.allocatedToThisP)}`).join(", ")}). ` +
      "Reverse the receipt first, then cancel the invoice."
    );
  }
  return null;
}

/** `Invoices.reassignCheck`, messages verbatim. Pass `newCustomerId` (and whether it names an existing, different shop) to also check the target. */
export async function changeShopRefusals(
  db: Executor,
  inv: InvoiceForRules,
  target?: { customerId: string | null; exists: boolean },
): Promise<string[]> {
  const errs: string[] = [];
  if (inv.status === "CANCELLED") errs.push(INVOICE_MESSAGES.cancelledMove);
  else if (inv.status === "DRAFT") errs.push(INVOICE_MESSAGES.draftMove);
  if (target) {
    if (!target.customerId || !target.exists) errs.push(INVOICE_MESSAGES.chooseNewShop);
    else if (target.customerId === inv.customerId) errs.push(INVOICE_MESSAGES.sameShop);
  }
  if (!isPosted(inv)) return errs;

  const rets = await activeReturns(db, inv.id);
  if (rets.length) {
    errs.push(
      `A return has been posted against this invoice (${rets.map((r) => r.number).join(", ")}). ` +
        `Its credit note and any refund belong to ${inv.shopNameSnapshot || "the current shop"}, ` +
        "so the invoice cannot be moved. Cancel the invoice and make a new one for the right shop instead.",
    );
  }
  for (const r of await receiptsOn(db, inv.id)) {
    if (r.status === "REVERSED" || r.wholly) continue;
    errs.push(
      `Receipt ${r.receiptNumber} (${formatMoney(r.amountP)}) was also applied to other invoices or left partly on account, ` +
        "so it belongs to the shop, not to this one invoice. Reverse that receipt first, move the invoice, then record the money again against the right shop.",
    );
  }
  return errs;
}
