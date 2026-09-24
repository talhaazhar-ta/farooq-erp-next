import { z } from "zod";
import {
  companyProfileSchema,
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
