import { formatBusinessDate, formatPaisaPlain } from "@farooq/shared";

export const fmtDate = (iso: string | null | undefined): string => (iso ? formatBusinessDate(iso) : "");
export const fmtMoney = (paisa: number): string => `PKR ${formatPaisaPlain(paisa)}`;

/** A timestamp from the server, shown in the business zone (Asia/Karachi) — never the viewer's own zone. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export type PartyKind = "CUSTOMER" | "SUPPLIER";

/**
 * A balance in words. Customer: positive = the shop owes us. Supplier: positive = we owe the supplier.
 * Never a bare negative number — a flipped sign says who owes whom.
 */
export function balanceWords(kind: PartyKind, balanceP: number): string {
  const amount = fmtMoney(Math.abs(balanceP));
  if (balanceP === 0) return "Settled — nothing owed either way";
  if (kind === "CUSTOMER") return balanceP > 0 ? `Shop owes us ${amount}` : `We owe the shop ${amount} (credit)`;
  return balanceP > 0 ? `We owe supplier ${amount}` : `Supplier owes us ${amount} (advance paid)`;
}

/** The running-balance cell of a statement: the amount, with "Cr" (customer) / "Dr" (supplier) when the sign has flipped. */
export function balanceCell(kind: PartyKind, balanceP: number): string {
  const text = formatPaisaPlain(Math.abs(balanceP));
  if (balanceP >= 0) return text;
  return `${text} ${kind === "CUSTOMER" ? "Cr" : "Dr"}`;
}

/** "PKR 1,500.00", or "PKR 1,500.00 Cr" (customer) / "Dr" (supplier) when the sign has flipped — for printed balances, where a bare minus would be ambiguous. */
export function moneyWithSide(kind: PartyKind, balanceP: number): string {
  return `PKR ${balanceCell(kind, balanceP)}`;
}

export const KIND_LABELS = {
  received: "Received from shop",
  paidToShops: "Paid to shop",
  paidToSuppliers: "Paid to supplier",
} as const;
