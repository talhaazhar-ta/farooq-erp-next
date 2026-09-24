import { z } from "zod";
import {
  companyProfileSchema,
  invoiceDetailSchema,
  productPickItemSchema,
  invoiceListResponseSchema,
  invoicePrintSchema,
  warehouseItemSchema,
  type CancelInvoiceInput,
  type ChangeInvoiceShopInput,
  type DuplicateInvoiceInput,
  type SaveInvoiceInput,
  outstandingDocumentSchema,
  partyBalanceSchema,
  partyLookupItemSchema,
  paymentDetailSchema,
  paymentListResponseSchema,
  paymentVoucherSchema,
  receiptSchema,
  regionSchema,
  statementSchema,
  type EditPaymentAmountInput,
  type PayPaymentInput,
  type ReceivePaymentInput,
  type RefundPaymentInput,
  type ReversePaymentInput,
} from "@farooq/shared";
import { api } from "./api";
import { toQueryString } from "./payment-filters";

/** Typed calls to the API. Every answer is checked against the shared Zod schema before a component sees it. */

export const keys = {
  payments: ["payments"] as const,
  paymentList: (params: Record<string, string>) => ["payments", "list", params] as const,
  payment: (id: string) => ["payments", "detail", id] as const,
  receipt: (id: string) => ["payments", "receipt", id] as const,
  balance: (type: PartyType, id: string) => ["balance", type, id] as const,
  outstanding: (id: string) => ["outstanding", id] as const,
  statement: (type: PartyType, id: string, from: string, to: string) => ["statement", type, id, from, to] as const,
  parties: (type: PartyType, q: string, regionId: string) => ["parties", type, q, regionId] as const,
  regions: ["regions"] as const,
  company: ["company"] as const,
  invoices: ["invoices"] as const,
  invoiceList: (params: Record<string, string>) => ["invoices", "list", params] as const,
  invoice: (id: string) => ["invoices", "detail", id] as const,
  invoicePrint: (id: string, template: string) => ["invoices", "print", id, template] as const,
  warehouses: ["warehouses"] as const,
  products: ["products"] as const,
  productSearch: (q: string, warehouseId: string, limit: number) => ["products", "search", q, warehouseId, limit] as const,
  productsByIds: (ids: string[]) => ["products", "ids", ...ids] as const,
};

export type PartyType = "customer" | "supplier";
const plural = (t: PartyType) => (t === "customer" ? "customers" : "suppliers");

export const listPayments = (params: Record<string, string>, signal?: AbortSignal) =>
  api.getParsed(`/payments${toQueryString(params)}`, paymentListResponseSchema, signal);

export const getPayment = (id: string) => api.getParsed(`/payments/${id}`, paymentDetailSchema);
export const getReceipt = (id: string) => api.getParsed(`/payments/${id}/receipt`, receiptSchema);

export const lookupParties = (type: PartyType, q: string, regionId: string, signal?: AbortSignal) =>
  api.getParsed(`/${plural(type)}${toQueryString({ ...(q.trim() ? { q: q.trim() } : {}), ...(regionId ? { regionId } : {}), limit: "20" })}`, z.array(partyLookupItemSchema), signal);

export const getBalance = (type: PartyType, id: string) => api.getParsed(`/${plural(type)}/${id}/balance`, partyBalanceSchema);

export const getOutstanding = (type: PartyType, id: string) =>
  api.getParsed(`/${plural(type)}/${id}/${type === "customer" ? "outstanding-invoices" : "outstanding-purchases"}`, z.array(outstandingDocumentSchema));

export const getStatement = (type: PartyType, id: string, from: string, to: string, signal?: AbortSignal) =>
  api.getParsed(`/${plural(type)}/${id}/statement${toQueryString({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`, statementSchema, signal);

export const getRegions = () => api.getParsed("/regions", z.array(regionSchema));
export const getCompany = () => api.getParsed("/company", companyProfileSchema);

export const receivePayment = (body: ReceivePaymentInput) => api.postParsed("/payments/receive", body, paymentVoucherSchema);
export const payPayment = (body: PayPaymentInput) => api.postParsed("/payments/pay", body, paymentVoucherSchema);
export const refundPayment = (body: RefundPaymentInput) => api.postParsed("/payments/refund", body, paymentVoucherSchema);
export const reversePayment = (id: string, body: ReversePaymentInput) => api.postParsed(`/payments/${id}/reverse`, body, paymentVoucherSchema);
export const editPaymentAmount = (id: string, body: EditPaymentAmountInput) => api.postParsed(`/payments/${id}/edit-amount`, body, paymentVoucherSchema);

/** The CSV: every match of the current filters (no paging), saved with the server's own file name. */
export async function exportPaymentsCsv(params: Record<string, string>): Promise<string> {
  const { blob, filename } = await api.download(`/payments/export.csv${toQueryString(params)}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

/* ── invoices (S9: read and correct; the builder is S10) ─────────────────────────────────────── */

export const listInvoices = (params: Record<string, string>, signal?: AbortSignal) =>
  api.getParsed(`/invoices${toQueryString(params)}`, invoiceListResponseSchema, signal);
export const getInvoice = (id: string) => api.getParsed(`/invoices/${id}`, invoiceDetailSchema);
export const getInvoicePrint = (id: string, template: string) =>
  api.getParsed(`/invoices/${id}/print${toQueryString(template ? { template } : {})}`, invoicePrintSchema);
export const getWarehouses = () => api.getParsed("/warehouses", z.array(warehouseItemSchema));

export const cancelInvoice = (id: string, body: CancelInvoiceInput) => api.postParsed(`/invoices/${id}/cancel`, body, invoiceDetailSchema);
export const duplicateInvoice = (id: string, body: DuplicateInvoiceInput) => api.postParsed(`/invoices/${id}/duplicate`, body, invoiceDetailSchema);
export const changeInvoiceShop = (id: string, body: ChangeInvoiceShopInput) => api.postParsed(`/invoices/${id}/change-shop`, body, invoiceDetailSchema);

/** Save an invoice: POST creates (draft or posted), PUT edits a draft / posts one / edits a posted invoice (the body carries the `revision` as loaded). */
export const saveInvoice = (body: SaveInvoiceInput, id?: string) =>
  id ? api.putParsed(`/invoices/${id}`, body, invoiceDetailSchema) : api.postParsed("/invoices", body, invoiceDetailSchema);

/** The builder's product search: words (name, Urdu name, brand, category, SKU, bag size), in-stock-first for a warehouse. */
export const searchProducts = (q: string, warehouseId: string, limit: number, signal?: AbortSignal) =>
  api.getParsed(`/products${toQueryString({ ...(q.trim() ? { q: q.trim() } : {}), ...(warehouseId ? { warehouseId } : {}), limit: String(limit) })}`, z.array(productPickItemSchema), signal);
/** Exactly these products (the ones already on an invoice), active or not. */
export const getProductsByIds = (ids: string[]) => api.getParsed(`/products${toQueryString({ ids: ids.join(","), limit: "100" })}`, z.array(productPickItemSchema));

/** The invoice CSV: every match of the current filters (no paging), saved with the server's own file name. */
export async function exportInvoicesCsv(params: Record<string, string>): Promise<string> {
  const { blob, filename } = await api.download(`/invoices/export.csv${toQueryString(params)}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}
