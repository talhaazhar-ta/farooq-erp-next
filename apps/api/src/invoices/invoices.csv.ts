import { INVOICE_STATUS_LABELS, milliToQty, rupeesText } from "@farooq/shared";
import type { Executor } from "@farooq/db";
import { csvCell } from "../payments/payments.csv.js";
import { loadInvoiceListRows, type InvoiceListRow } from "./invoices.list.js";
import { searchInvoices, type InvoiceFilters } from "./invoices.search.js";

/**
 * `GET /invoices/export.csv` — every match of the current filters (no paging), the legacy `LIST.exportCsv` columns
 * (05-ui-builder.js): Invoice, Date, Shop, Owner, Region, Warehouse, Items, Bags, Subtotal, Discount, Charges, Grand total, Paid,
 * Balance, Status. Same file rules as the payments CSV (S4 deviation 7): UTF-8 WITH a byte-order mark so Excel opens Urdu names,
 * every cell in double quotes, CRLF line ends, a spreadsheet-injection guard (`csvCell`), money as plain rupees ("1500.50").
 * A draft's number cell says "DRAFT" (the legacy did). File name: `farooq-co-invoices-<business date>.csv`.
 */

const UTF8_BOM = String.fromCharCode(0xfeff);

export const INVOICE_CSV_HEADER = ["Invoice", "Date", "Shop", "Owner", "Region", "Warehouse", "Items", "Bags", "Subtotal", "Discount", "Charges", "Grand total", "Paid", "Balance", "Status"] as const;

export function invoiceCsvRow(r: InvoiceListRow): string[] {
  const i = r.inv;
  return [
    i.invoiceNumber || "DRAFT",
    i.date,
    i.shopNameSnapshot ?? "",
    i.customerNameSnapshot ?? "",
    i.regionSnapshot ?? "",
    i.warehouseSnapshot ?? "",
    String(i.lineCount),
    String(milliToQty(i.totalQtyMilli)),
    rupeesText(i.subtotalP),
    rupeesText(i.itemDiscountsP + i.invoiceDiscountP),
    rupeesText(i.freightP + i.loadingP + i.otherChargesP + i.taxP),
    rupeesText(i.totalP),
    rupeesText(r.paidP),
    rupeesText(r.outstandingP),
    (INVOICE_STATUS_LABELS as Record<string, string>)[i.status] ?? i.status,
  ];
}

export async function exportInvoicesCsv(db: Executor, filters: InvoiceFilters): Promise<{ csv: string; count: number }> {
  const found = await searchInvoices(db, filters); // no page: every match
  const rows = await loadInvoiceListRows(db, found.rows);
  const lines = [INVOICE_CSV_HEADER as readonly string[], ...rows.map(invoiceCsvRow)].map((cells) => cells.map(csvCell).join(","));
  return { csv: UTF8_BOM + lines.join("\r\n") + "\r\n", count: rows.length };
}
