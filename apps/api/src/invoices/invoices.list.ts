import { inArray } from "drizzle-orm";
import { invoices, type Executor } from "@farooq/db";
import { milliToQty, paymentStatusOf, type InvoiceListItem, type InvoiceListResponse, type ListInvoicesQuery } from "@farooq/shared";
import { hitsFor, searchInvoices, type InvoiceFilters, type InvoiceSearchRow } from "./invoices.search.js";

/** The invoice list (legacy `PAGES.invoices`, 05-ui-builder.js §37–39) and what its CSV needs: rows in the order of the search. */

type InvoiceRow = typeof invoices.$inferSelect;

/** An invoice as the list draws it: the row, what was paid against it and the credit of its returns. */
export interface InvoiceListRow {
  inv: InvoiceRow;
  paidP: number;
  creditP: number;
  /** total − paid − credit (the legacy `Invoices.outstanding`). */
  outstandingP: number;
}

/** Loads the invoices named by a search page, in that order. */
export async function loadInvoiceListRows(db: Executor, found: InvoiceSearchRow[]): Promise<InvoiceListRow[]> {
  if (found.length === 0) return [];
  const rows = await db.select().from(invoices).where(inArray(invoices.id, found.map((r) => r.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return found.flatMap((f) => {
    const inv = byId.get(f.id);
    return inv ? [{ inv, paidP: f.paidP, creditP: f.creditP, outstandingP: inv.totalP - f.paidP - f.creditP }] : [];
  });
}

const toItem = (r: InvoiceListRow, hits: InvoiceListItem["hits"]): InvoiceListItem => {
  const i = r.inv;
  return {
    id: i.id,
    number: i.invoiceNumber,
    orderNumber: i.orderNumber,
    date: i.date,
    status: i.status,
    paymentStatus: paymentStatusOf(i.totalP, r.paidP),
    customerId: i.customerId,
    shopName: i.shopNameSnapshot,
    ownerName: i.customerNameSnapshot,
    region: i.regionSnapshot,
    warehouse: i.warehouseSnapshot,
    itemCount: i.lineCount,
    quantity: milliToQty(i.totalQtyMilli),
    subtotalP: i.subtotalP,
    discountP: i.itemDiscountsP + i.invoiceDiscountP,
    chargesP: i.freightP + i.loadingP + i.otherChargesP + i.taxP,
    totalP: i.totalP,
    paidP: r.paidP,
    outstandingP: r.outstandingP,
    hits,
  };
};

/** `GET /invoices`: the search of legacy module 33, on the server. See invoices.search.ts. */
export async function listInvoices(db: Executor, q: ListInvoicesQuery): Promise<InvoiceListResponse> {
  const { limit, offset, ...filters } = q;
  const found = await searchInvoices(db, filters as InvoiceFilters, { limit, offset });
  const rows = await loadInvoiceListRows(db, found.rows);
  const hits = await hitsFor(db, rows.map((r) => r.inv.id), found.interpreted.terms, q.scope ?? "all");
  return {
    items: rows.map((r) => toItem(r, hits.get(r.inv.id) ?? null)),
    total: found.total,
    limit,
    offset,
    interpreted: found.interpreted,
    kpis: found.kpis,
    statusFacets: found.statusFacets,
    onFile: found.onFile,
  };
}
