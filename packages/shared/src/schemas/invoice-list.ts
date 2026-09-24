import { z } from "zod";
import { isValidBusinessDate } from "../dates.js";
import { MAX_AMOUNT_P } from "../money.js";
import { searchInterpretationSchema } from "./payments.js";
import { INVOICE_PAYMENT_STATUSES } from "./invoices.js";

/**
 * The invoice list and its search (S8): the legacy module 33 on the server. Request and response shapes shared by apps/api
 * and (from S9) apps/web. Money is integer paisa (`...P`), dates are `YYYY-MM-DD` business dates, quantities are bags.
 */

/** The eight statuses an invoice can carry (legacy `ENUM.invoiceStatus`), in the order the legacy status filter lists them. */
export const INVOICE_STATUSES = ["DRAFT", "CONFIRMED", "DISPATCHED", "PARTIALLY_PAID", "PAID", "CANCELLED", "RETURNED", "PARTIALLY_RETURNED"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** The legacy `ERP.STATUS_LABEL` — what a status is called on screen, in a printed invoice, in the CSV and in the search index. */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus | "UNPAID" | "PARTIAL", string> = {
  DRAFT: "Draft",
  CONFIRMED: "Confirmed",
  DISPATCHED: "Dispatched",
  PARTIALLY_PAID: "Partly paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
  PARTIALLY_RETURNED: "Partly returned",
  UNPAID: "Unpaid",
  PARTIAL: "Partly paid",
};

/** The legacy `ERP.InvoiceSearch.SCOPES`: which part of an invoice the typed words are looked for in. */
export const INVOICE_SEARCH_SCOPES = ["all", "number", "customer", "product", "amount", "payment", "notes"] as const;
export type InvoiceSearchScope = (typeof INVOICE_SEARCH_SCOPES)[number];
export const INVOICE_SEARCH_SCOPE_LABELS: Record<InvoiceSearchScope, string> = {
  all: "Everything",
  number: "Invoice / order no.",
  customer: "Customer / phone",
  product: "Product",
  amount: "Amount",
  payment: "Receipt / payment ref.",
  notes: "Notes & other",
};

/** The legacy `SORTS`. */
export const INVOICE_SORTS = ["newest", "oldest", "high", "low", "due"] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];
export const INVOICE_SORT_LABELS: Record<InvoiceSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  high: "Highest total",
  low: "Lowest total",
  due: "Highest balance due",
};

/** The list's own refusals (the legacy wording, "invoice" for "payment"). */
export const INVOICE_SEARCH_PROBLEMS = {
  fromAfterTo: "The “From” date is after the “To” date, so no invoice can match.",
  minAboveMax: "The minimum total is above the maximum, so no invoice can match.",
} as const;

const blankIsAbsent = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
const businessDate = z.string().refine(isValidBusinessDate, "Enter a valid date (YYYY-MM-DD).");
const uuid = z.string().uuid();
const paisaBound = z.coerce.number().int().min(0).max(MAX_AMOUNT_P);

/** Filters shared by the list and the CSV export (the CSV has no paging). Dates are from / to — the screen turns "this week" into them. */
export const invoiceFilterShape = {
  /** The raw text of the search box: words (AND, any order) and dates are read from it by the server. */
  q: blankIsAbsent(z.string().max(200)),
  scope: blankIsAbsent(z.enum(INVOICE_SEARCH_SCOPES)),
  status: blankIsAbsent(z.enum(INVOICE_STATUSES)),
  /** The region printed on the invoice (its snapshot), not the shop's current region. */
  regionId: blankIsAbsent(uuid),
  warehouseId: blankIsAbsent(uuid),
  from: blankIsAbsent(businessDate),
  to: blankIsAbsent(businessDate),
  /** On the grand total, paisa. */
  minP: blankIsAbsent(paisaBound),
  maxP: blankIsAbsent(paisaBound),
  sort: blankIsAbsent(z.enum(INVOICE_SORTS)),
};

export const listInvoicesQuerySchema = z
  .object({
    ...invoiceFilterShape,
    limit: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(1).max(200).default(50)),
    offset: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).max(1_000_000).default(0)),
  })
  .strict();
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const exportInvoicesQuerySchema = z.object(invoiceFilterShape).strict();
export type ExportInvoicesQuery = z.infer<typeof exportInvoicesQuerySchema>;

/** Why a row is in the list when the words landed on a product or a receipt ("Taj Mahal Sella × 20", "Paid by REC-2026-000031 (cheque 4471)"). */
export const invoiceHitSchema = z.object({
  /** Up to three matching product lines. */
  lines: z.array(z.object({ name: z.string(), quantity: z.number() })),
  more: z.number().int(),
  /** Up to three receipts, as "REC-2026-000031" or "REC-2026-000031 (4471)". */
  pays: z.array(z.string()),
  morePays: z.number().int(),
});
export type InvoiceHit = z.infer<typeof invoiceHitSchema>;

export const invoiceListItemSchema = z.object({
  id: z.string().uuid(),
  /** Null for a draft (the screen says "Draft"). */
  number: z.string().nullable(),
  orderNumber: z.string().nullable(),
  date: z.string(),
  status: z.string(),
  /** Derived from the receipts applied, as everywhere: UNPAID / PARTIAL / PAID. */
  paymentStatus: z.enum(INVOICE_PAYMENT_STATUSES),
  customerId: z.string().uuid().nullable(),
  /** What the invoice printed when it was made. */
  shopName: z.string().nullable(),
  ownerName: z.string().nullable(),
  region: z.string().nullable(),
  warehouse: z.string().nullable(),
  itemCount: z.number().int(),
  /** Bags in all. */
  quantity: z.number(),
  subtotalP: z.number().int(),
  /** Item discounts + invoice discount. */
  discountP: z.number().int(),
  /** Freight + loading + other + tax (the legacy CSV's "Charges"). */
  chargesP: z.number().int(),
  totalP: z.number().int(),
  /** Allocations of POSTED receipts. */
  paidP: z.number().int(),
  /** Total − paid − credit of non-cancelled returns (the legacy "Balance"). */
  outstandingP: z.number().int(),
  hits: invoiceHitSchema.nullable(),
});
export type InvoiceListItem = z.infer<typeof invoiceListItemSchema>;

const statusFacetSchema = z.object({ count: z.number().int(), totalP: z.number().int() });

export const invoiceListResponseSchema = z.object({
  items: z.array(invoiceListItemSchema),
  /** Matches of ALL the filters (what paging walks through). */
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  interpreted: searchInterpretationSchema,
  /** The four cards over the WHOLE filtered list (not just this page), drafts and cancelled invoices left out — except `drafts`, which counts every draft on file. */
  kpis: z.object({
    count: z.number().int(),
    drafts: z.number().int(),
    invoicedP: z.number().int(),
    receivedP: z.number().int(),
    outstandingP: z.number().int(),
  }),
  /** Counts and totals by status under every filter EXCEPT the status one, so a status picker can show them. */
  statusFacets: z.object(Object.fromEntries(INVOICE_STATUSES.map((s) => [s, statusFacetSchema])) as Record<InvoiceStatus, typeof statusFacetSchema>),
  /** Every invoice on file, unfiltered ("12 of 340 invoices match"). */
  onFile: z.number().int(),
});
export type InvoiceListResponse = z.infer<typeof invoiceListResponseSchema>;
