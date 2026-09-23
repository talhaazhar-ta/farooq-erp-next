import { and, eq, sql } from "drizzle-orm";
import { paymentAllocations, returns, type Executor } from "@farooq/db";

/** The exact wording of the legacy `Payments.editAmountCheck` / `editAmount` refusals (S4 shows these verbatim). */
export const EDIT_AMOUNT_MESSAGES = {
  notFound: "Payment not found.",
  reversed: "A reversed voucher cannot be edited.",
  wrongKind: "Only a voucher paid to a shop or a supplier can have its amount corrected here.",
  allocated: "This payment is applied to an invoice or purchase; its amount can’t be changed here.",
  returnRefund: "This voucher is the refund for a customer return — correct the return instead.",
  amount: "Enter an amount greater than zero.",
  unchanged: "That is already the recorded amount.",
} as const;

export const REVERSE_MESSAGES = {
  alreadyReversed: "This voucher is already reversed.",
} as const;

export interface PaymentFacts {
  id: string;
  direction: string;
  partyType: string;
  status: string;
  reference: string | null;
  note: string | null;
}

/**
 * The legacy `editAmountCheck`, in the legacy order (the first refusal wins):
 *   1. REVERSED                                   2. not an OUT voucher to a shop or supplier
 *   3. has any allocation                         4. the cash side of a customer return's REFUND treatment
 * (1 "not found" is the caller's job.)
 *
 * Rule 4 is deliberately never looser than the legacy: it refuses when EITHER the FK `returns.refund_payment_id`
 * points at this voucher OR the legacy heuristic matches (note starts "Refund against return " AND the reference
 * equals some customer return's number).
 */
export async function editAmountRefusal(db: Executor, p: PaymentFacts): Promise<string | null> {
  if (p.status === "REVERSED") return EDIT_AMOUNT_MESSAGES.reversed;
  if (p.direction !== "OUT" || (p.partyType !== "CUSTOMER" && p.partyType !== "SUPPLIER")) return EDIT_AMOUNT_MESSAGES.wrongKind;

  const [alloc] = await db.select({ n: sql<number>`count(*)::int` }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, p.id));
  if ((alloc?.n ?? 0) > 0) return EDIT_AMOUNT_MESSAGES.allocated;

  const [tied] = await db.select({ n: sql<number>`count(*)::int` }).from(returns).where(eq(returns.refundPaymentId, p.id));
  if ((tied?.n ?? 0) > 0) return EDIT_AMOUNT_MESSAGES.returnRefund;

  if (p.partyType === "CUSTOMER" && /^Refund against return /.test(p.note ?? "") && p.reference) {
    const [byNumber] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(returns)
      .where(and(eq(returns.kind, "CUSTOMER"), eq(returns.returnNumber, p.reference)));
    if ((byNumber?.n ?? 0) > 0) return EDIT_AMOUNT_MESSAGES.returnRefund;
  }
  return null;
}
