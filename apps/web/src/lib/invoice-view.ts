import type { InvoiceDetail } from "@farooq/shared";
import { fmtMoney } from "./format";

/** Receipts of an invoice that still count (a reversed receipt no longer moves money). */
export const postedReceipts = (inv: Pick<InvoiceDetail, "receipts">) => inv.receipts.filter((r) => r.status === "POSTED");

export interface ShopMoveFigures {
  /** What the invoice adds to the shop's balance once the receipts taken with it are counted: total − the receipts that move with it. */
  netP: number;
  oldBalanceNowP: number;
  oldBalanceAfterP: number;
  newBalanceNowP: number | null;
  newBalanceAfterP: number | null;
}

/**
 * The legacy Change-shop arithmetic (06-wiring.js `changeShopBalanceHtml`): the invoice total less whatever was received
 * WITH it, since that receipt moves too. The old shop's balance goes down by that, the new shop's up by it. Computed
 * from the invoice detail and the two shops' balances — the server has no preview endpoint, and the balances shown are
 * the ones the ledger will really have (the server refuses a receipt it cannot move, and says so on Save).
 */
export function shopMoveFigures(inv: Pick<InvoiceDetail, "totalP" | "receipts">, oldBalanceP: number, newBalanceP: number | null): ShopMoveFigures {
  const moved = postedReceipts(inv).reduce((a, r) => a + r.allocatedP, 0);
  const netP = inv.totalP - moved;
  return {
    netP,
    oldBalanceNowP: oldBalanceP,
    oldBalanceAfterP: oldBalanceP - netP,
    newBalanceNowP: newBalanceP,
    newBalanceAfterP: newBalanceP === null ? null : newBalanceP + netP,
  };
}

/** What cancelling does, in the words of the shop it touches — shown BEFORE the person confirms. */
export function cancelEffect(inv: Pick<InvoiceDetail, "status" | "number" | "totalP" | "totalQuantity">): string[] {
  if (inv.status === "DRAFT") {
    return ["This draft has no number, no stock and no account entry, so nothing else changes.", "The draft stays on file, marked Cancelled, with your reason."];
  }
  return [
    `The bags come back into stock (${inv.totalQuantity} in all, to the godown each line left from).`,
    `The invoice leaves the shop’s balance — it goes down by ${fmtMoney(inv.totalP)} — and the statement no longer shows it.`,
    "The invoice stays on file, marked Cancelled, with your reason. It cannot be undone; duplicate it if the sale still goes ahead.",
  ];
}

/** The shop's name as the invoice printed it. */
export const shopOf = (inv: Pick<InvoiceDetail, "shop">): string => inv.shop.shopName ?? inv.shop.name ?? "";

/** The number, or "Draft" — a draft has none. */
export const invoiceTitle = (number: string | null): string => number ?? "Draft";
