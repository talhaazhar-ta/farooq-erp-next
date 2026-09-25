import { z } from "zod";
import { isValidBusinessDate } from "../dates.js";
import { searchInterpretationSchema } from "./payments.js";
import { PURCHASE_PAYMENT_STATUSES } from "./purchases.js";

/**
 * The purchase list and its search (S13): the legacy Purchases page (farooq-co-erp.html `PAGES.purchases`, the `Mirror` rows of
 * 02-services.js and the toolbar match) on the server. Request and response shapes shared by apps/api and apps/web. Money is integer
 * paisa (`...P`), dates are `YYYY-MM-DD` business dates, quantities are bags.
 */

/** The legacy page's wording, verbatim (farooq-co-erp.html `PAGES.purchases` + `toolbar`); the first card's label is the fix-4 one (see below). */
export const PURCHASE_LIST_LABELS = {
  title: "Goods received",
  subtitle: "Every delivery must name a destination warehouse",
  placeholder: "Search supplier, product or invoice…",
  allWarehouses: "All warehouses",
  allCategories: "All categories",
  allStatuses: "All statuses",
  empty: "No purchases recorded yet",
  emptyHint: "Receiving stock adds bags to the destination warehouse you choose.",
  noMatch: "Nothing matches these filters",
  noMatchHint: "Try a wider date range, another warehouse or region, or clear the search.",
  /** Card 1 counts the bags that ARRIVED (fix 4: the legacy summed the ordered bags under this label). */
  cardBags: "Bags received",
  cardValue: "Purchase value",
  cardValueNote: "Where a rate was entered",
  cardOwed: "Owed to suppliers",
  cardSuppliers: "Suppliers",
  columns: ["Date", "Supplier ref", "Supplier", "Product", "Bag size", "Warehouse", "Bags", "Rate", "Amount", "Payment", "Actions"],
} as const;

/** The legacy toolbar's payment choices ('Paid', 'Unpaid', 'Partial') and the `Mirror` row's `pay` word. */
export const PURCHASE_PAY_LABELS: Record<(typeof PURCHASE_PAYMENT_STATUSES)[number], string> = { PAID: "Paid", UNPAID: "Unpaid", PARTIAL: "Partial" };

/**
 * The status a purchase carries. The legacy `STATUS_LABEL` names DRAFT and CANCELLED only; the three delivery states are new wording
 * (the legacy printed the raw word).
 */
export const PURCHASE_STATUSES = ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];
export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  DRAFT: "Draft",
  ORDERED: "Ordered",
  PARTIALLY_RECEIVED: "Partly received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

/** Sorts (the legacy page only listed newest first; the others are the invoice list's). */
export const PURCHASE_SORTS = ["newest", "oldest", "high", "low", "due"] as const;
export type PurchaseSort = (typeof PURCHASE_SORTS)[number];
export const PURCHASE_SORT_LABELS: Record<PurchaseSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  high: "Highest total",
  low: "Lowest total",
  due: "Highest balance due",
};

export const PURCHASE_SEARCH_PROBLEMS = {
  fromAfterTo: "The “From” date is after the “To” date, so no purchase can match.",
} as const;

const blankIsAbsent = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
const businessDate = z.string().refine(isValidBusinessDate, "Enter a valid date (YYYY-MM-DD).");

/** Filters shared by the list and the CSV (the CSV has no paging). */
export const purchaseFilterShape = {
  /** The raw search box: every word must be found (any order); a date typed in it is a date filter. */
  q: blankIsAbsent(z.string().max(200)),
  /** A godown: the purchase's own (header) warehouse or the godown of any of its lines. */
  warehouseId: blankIsAbsent(z.string().uuid()),
  /** A product category (`products.category`): any line's product in it. */
  category: blankIsAbsent(z.string().max(100)),
  /** Derived from the allocations of POSTED vouchers — never stored. */
  paymentStatus: blankIsAbsent(z.enum(PURCHASE_PAYMENT_STATUSES)),
  from: blankIsAbsent(businessDate),
  to: blankIsAbsent(businessDate),
  sort: blankIsAbsent(z.enum(PURCHASE_SORTS)),
};

export const listPurchasesQuerySchema = z
  .object({
    ...purchaseFilterShape,
    limit: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(1).max(200).default(50)),
    offset: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).max(1_000_000).default(0)),
  })
  .strict();
export type ListPurchasesQuery = z.infer<typeof listPurchasesQuerySchema>;

export const exportPurchasesQuerySchema = z.object(purchaseFilterShape).strict();
export type ExportPurchasesQuery = z.infer<typeof exportPurchasesQuerySchema>;

/** Why a row is in the list when the words landed on a product line other than the first ("Zam Zam × 100 · +1 more"). */
export const purchaseHitSchema = z.object({
  lines: z.array(z.object({ name: z.string(), quantity: z.number() })),
  more: z.number().int(),
});
export type PurchaseHit = z.infer<typeof purchaseHitSchema>;

export const purchaseListItemSchema = z.object({
  id: z.string().uuid(),
  number: z.string().nullable(),
  date: z.string(),
  status: z.string(),
  paymentStatus: z.enum(PURCHASE_PAYMENT_STATUSES),
  supplierId: z.string().uuid().nullable(),
  /** As printed on the bill when it was made. */
  supplierName: z.string().nullable(),
  /** The supplier's name now (null when it is the same as printed, or unknown). */
  supplierCurrentName: z.string().nullable(),
  /** The supplier's own bill number ("Supplier ref"). */
  supplierInvoiceNo: z.string().nullable(),
  /** The header godown as printed. */
  warehouse: z.string().nullable(),
  /** The first line, as the legacy row drew it (Product / Bag size / Rate); null for a purchase without lines. */
  firstLine: z
    .object({ name: z.string(), nameUr: z.string().nullable(), package: z.string().nullable(), unitPriceP: z.number().int() })
    .nullable(),
  lineCount: z.number().int(),
  /** Bags ordered and bags that arrived (fix 4: never one figure under the other's name). */
  orderedQuantity: z.number(),
  receivedQuantity: z.number(),
  totalP: z.number().int(),
  /** Allocations of POSTED vouchers. */
  paidP: z.number().int(),
  balanceP: z.number().int(),
  hits: purchaseHitSchema.nullable(),
});
export type PurchaseListItem = z.infer<typeof purchaseListItemSchema>;

const facet = z.object({ count: z.number().int(), totalP: z.number().int() });

export const purchaseListResponseSchema = z.object({
  items: z.array(purchaseListItemSchema),
  /** Matches of ALL the filters (what paging walks through). */
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  interpreted: searchInterpretationSchema,
  /** The four cards over the WHOLE filtered list (every page), cancelled purchases left out. */
  kpis: z.object({
    /** Purchases counted. */
    count: z.number().int(),
    receivedQuantity: z.number(),
    orderedQuantity: z.number(),
    /** Σ grand totals. */
    valueP: z.number().int(),
    /** Σ (grand total − paid): what is still owed on these bills. */
    owedP: z.number().int(),
    /** Suppliers behind these purchases, and how many of them are still owed on them. */
    suppliers: z.number().int(),
    suppliersOwed: z.number().int(),
  }),
  /** Counts and totals by payment status under every filter EXCEPT the payment one (the picker shows them). */
  payFacets: z.object({ PAID: facet, UNPAID: facet, PARTIAL: facet }),
  /** The categories products carry (the category picker's choices). */
  categories: z.array(z.string()),
  /** Every purchase on file, unfiltered ("12 of 40 purchases match"). */
  onFile: z.number().int(),
});
export type PurchaseListResponse = z.infer<typeof purchaseListResponseSchema>;
