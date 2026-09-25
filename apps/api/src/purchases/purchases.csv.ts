import { milliToQty, PURCHASE_PAY_LABELS, PURCHASE_STATUS_LABELS, rupeesText, paymentStatusOf } from "@farooq/shared";
import type { Executor } from "@farooq/db";
import { csvCell } from "../payments/payments.csv.js";
import { loadPurchaseListRows, type PurchaseListRow } from "./purchases.list.js";
import { searchPurchases, type PurchaseFilters } from "./purchases.search.js";

/**
 * `GET /purchases/export.csv` — every match of the current filters (no paging). The legacy exported the table as drawn: Date, Supplier ref,
 * Supplier, Product, Bag size, Warehouse, Bags, Rate, Amount, Payment. Here: the purchase number first (the legacy row carried it only on its
 * "Invoice" button), "Bags" split into ordered and received (fix 4), and Paid / Balance / Status added. Same file rules as the payments and
 * invoices CSV: UTF-8 with a byte-order mark, every cell quoted, CRLF, the spreadsheet-injection guard, money as plain rupees.
 * File name: `farooq-co-purchases-<business date>.csv`.
 */

const UTF8_BOM = String.fromCharCode(0xfeff);

export const PURCHASE_CSV_HEADER = [
  "Purchase",
  "Date",
  "Supplier ref",
  "Supplier",
  "Product",
  "Bag size",
  "Warehouse",
  "Bags ordered",
  "Bags received",
  "Rate",
  "Amount",
  "Paid",
  "Balance",
  "Payment",
  "Status",
] as const;

export function purchaseCsvRow(r: PurchaseListRow): string[] {
  const p = r.pu;
  const cancelled = p.status === "CANCELLED";
  return [
    p.purchaseNumber ?? "",
    p.date,
    p.supplierInvoiceNo ?? "",
    p.supplierNameSnapshot ?? r.supplierNow ?? "",
    r.first ? r.first.descriptionEnSnapshot || r.first.descriptionSnapshot || "" : "",
    r.first?.packageSnapshot ?? "",
    p.warehouseSnapshot ?? "",
    String(milliToQty(p.orderedQtyMilli)),
    String(milliToQty(p.receivedQtyMilli)),
    r.first ? rupeesText(r.first.unitPriceP) : "",
    rupeesText(p.totalP),
    rupeesText(r.paidP),
    cancelled ? "" : rupeesText(p.totalP - r.paidP),
    PURCHASE_PAY_LABELS[paymentStatusOf(p.totalP, r.paidP)],
    (PURCHASE_STATUS_LABELS as Record<string, string>)[p.status] ?? p.status,
  ];
}

export async function exportPurchasesCsv(db: Executor, filters: PurchaseFilters): Promise<{ csv: string; count: number }> {
  const found = await searchPurchases(db, filters);
  const rows = await loadPurchaseListRows(db, found.rows);
  const lines = [PURCHASE_CSV_HEADER as readonly string[], ...rows.map(purchaseCsvRow)].map((cells) => cells.map(csvCell).join(","));
  return { csv: UTF8_BOM + lines.join("\r\n") + "\r\n", count: rows.length };
}
