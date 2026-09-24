import { rupeesText } from "@farooq/shared";
import type { Executor } from "@farooq/db";
import { loadListRows, type ListRow } from "./payments.queries.js";
import { searchPayments, type PaymentFilters } from "./payments.search.js";

/**
 * `GET /payments/export.csv` — every match of the current filters (no paging), the legacy 38-payment-search columns.
 *
 *  - UTF-8 WITH a byte-order mark, so Excel opens Urdu names correctly;
 *  - RFC 4180: every cell in double quotes (as the legacy did), a quote inside a cell doubled, CRLF line ends;
 *  - spreadsheet-injection guard: a cell whose text starts with `=`, `+`, `-`, `@`, TAB or CR gets a leading apostrophe,
 *    so `=cmd|'/c calc'!A0` in a reference or note is shown as text, never run as a formula (OWASP CSV injection).
 */

/** The byte-order mark: it makes Excel read the file as UTF-8, so Urdu names arrive intact. */
const UTF8_BOM = String.fromCharCode(0xfeff);

export const CSV_HEADER = ["Number", "Date", "Kind", "Party", "Owner / contact", "Region", "Method", "Amount", "Reference", "Applied to", "On account", "Note", "Status", "Why reversed"] as const;

const KIND_LABEL: Record<string, string> = { received: "Received from shop", paidToShops: "Paid to shop", paidToSuppliers: "Paid to supplier" };

/** One cell: neutralise a formula prefix, double the quotes, wrap in quotes. */
export function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRowOf(r: ListRow): string[] {
  const p = r.p;
  const kind = p.direction === "IN" ? "received" : p.partyType === "CUSTOMER" ? "paidToShops" : "paidToSuppliers";
  // the printed region snapshot, else the shop's current region as "اردو English" (the legacy `regionTxt`)
  const region = p.regionSnapshot || (r.regionEn ? [r.regionUr, r.regionEn].filter(Boolean).join(" ") : "");
  return [
    p.receiptNumber,
    p.paymentDate,
    KIND_LABEL[kind]!,
    p.partyNameSnapshot ?? "",
    p.partyOwnerSnapshot ?? "",
    region,
    p.method ?? "",
    rupeesText(p.amountP),
    p.reference ?? "",
    r.refs.join(" "),
    rupeesText(Math.max(0, p.amountP - r.allocatedP)),
    p.note ?? "",
    p.status === "REVERSED" ? "Reversed" : "Posted",
    p.reverseReason ?? "",
  ];
}

export async function exportPaymentsCsv(db: Executor, filters: PaymentFilters): Promise<{ csv: string; count: number }> {
  const found = await searchPayments(db, filters); // no page: every match
  const rows = await loadListRows(db, found.ids);
  const lines = [CSV_HEADER as readonly string[], ...rows.map(csvRowOf)].map((cells) => cells.map(csvCell).join(","));
  return { csv: UTF8_BOM + lines.join("\r\n") + "\r\n", count: rows.length };
}
