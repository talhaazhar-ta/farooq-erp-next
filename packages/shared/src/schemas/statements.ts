import { z } from "zod";
import { isValidBusinessDate } from "../dates.js";

/**
 * Account statements, printed receipts / vouchers, the company profile and regions (S4). Response shapes only —
 * S5 prints from these. Money is integer paisa (`...P`), dates are `YYYY-MM-DD` business dates, timestamps are ISO.
 */

const businessDate = z.string().refine(isValidBusinessDate, "Enter a valid date (YYYY-MM-DD).");
const blankIsAbsent = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/* ── company profile ──────────────────────────────────────────────────── */

/**
 * The display fields of the legacy `business` settings document that a printed page needs — and nothing else
 * (invoice prefixes, SMS providers, approval switches … never leave the server). Every field can be absent.
 */
export const companyProfileSchema = z.object({
  businessName: z.string().nullable(),
  legalName: z.string().nullable(),
  tagline: z.string().nullable(),
  taglineUr: z.string().nullable(),
  slogan: z.string().nullable(),
  /** The letters printed as a logo when there is no picture (legacy default "F&C"). */
  logoText: z.string(),
  /** A `data:image/...` URL when the business uploaded a logo. */
  logoDataUrl: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  phone: z.string().nullable(),
  shopPhone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  ntn: z.string().nullable(),
  registrationNo: z.string().nullable(),
  proprietor: z.string().nullable(),
  /** The currency word on documents (legacy default "PKR"). */
  currencyLabel: z.string(),
  bankDetails: z.string().nullable(),
  preparedByLabel: z.string().nullable(),
  receivedByLabel: z.string().nullable(),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

/** The keys read from the settings document, in the order of `companyProfileSchema`. */
export const COMPANY_DISPLAY_FIELDS = [
  "businessName", "legalName", "tagline", "taglineUr", "slogan", "logoText", "logoDataUrl", "address", "city", "phone",
  "shopPhone", "whatsapp", "email", "website", "ntn", "registrationNo", "proprietor", "currencyLabel", "bankDetails",
  "preparedByLabel", "receivedByLabel",
] as const;

export const regionSchema = z.object({
  id: z.string().uuid(),
  nameEn: z.string(),
  nameUr: z.string().nullable(),
  active: z.boolean(),
});
export type Region = z.infer<typeof regionSchema>;

/* ── statements ───────────────────────────────────────────────────────── */

export const statementQuerySchema = z
  .object({
    from: blankIsAbsent(businessDate),
    to: blankIsAbsent(businessDate),
  })
  .strict();
export type StatementQuery = z.infer<typeof statementQuerySchema>;

/** What a row is — the legacy `Ledger` row kinds; anything a later module posts that has no name here is OTHER. */
export const STATEMENT_ROW_KINDS = ["INVOICE", "PAYMENT", "REFUND", "RETURN", "OPENING", "PURCHASE", "ADJUSTMENT", "MILLING", "OTHER"] as const;
export type StatementRowKind = (typeof STATEMENT_ROW_KINDS)[number];

export const statementRowSchema = z.object({
  date: z.string(),
  createdAt: z.string(),
  kind: z.enum(STATEMENT_ROW_KINDS),
  /** The document number (invoice, receipt, return …); "OPENING" for the opening balance. */
  ref: z.string(),
  /** The legacy ledger wording: "Sales invoice", "Payment received — Cash", "Credit note — return" … */
  description: z.string(),
  /** Customers: invoice / refund = debit, receipt / return = credit. Suppliers: purchase = credit, payment / return = debit. */
  debitP: z.number().int(),
  creditP: z.number().int(),
  /** Running balance after this row: customers debit − credit (positive = the shop owes us), suppliers credit − debit (positive = we owe them). */
  balanceP: z.number().int(),
  source: z.object({ type: z.string(), id: z.string().uuid() }),
});
export type StatementRow = z.infer<typeof statementRowSchema>;

export const statementSchema = z.object({
  party: z.object({
    type: z.enum(["CUSTOMER", "SUPPLIER"]),
    id: z.string().uuid(),
    name: z.string(),
    /** Shop owner / contact person. */
    owner: z.string().nullable(),
    region: z.string().nullable(),
    phone: z.string().nullable(),
    legacyCode: z.string().nullable(),
  }),
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** The balance before `from` (0 when there is no `from`). opening + Σ rows = closing. */
  opening: z.number().int(),
  rows: z.array(statementRowSchema),
  totals: z.object({ debitP: z.number().int(), creditP: z.number().int() }),
  /** The balance after the last row (through `to`). */
  closing: z.number().int(),
  /** Reversed vouchers (payments and adjustments) dated inside the window: both their entries are left out, as in the legacy. */
  omittedReversed: z.number().int(),
});
export type Statement = z.infer<typeof statementSchema>;

/* ── receipt / voucher ────────────────────────────────────────────────── */

/** The legacy wording of a printed receipt (04-documents.js `receipt`), verbatim — S5 prints these, it does not retype them. */
export const RECEIPT_LABELS = {
  receipt: { title: "PAYMENT RECEIPT", party: "RECEIVED FROM", amount: "Amount received", amountUr: "وصول رقم" },
  voucher: { title: "PAYMENT VOUCHER", party: "PAID TO", amount: "Amount paid", amountUr: "ادا شدہ رقم" },
  meta: "RECEIPT DETAILS",
  metaNumber: "Receipt No",
  metaDate: "Date",
  metaMethod: "Method",
  metaReference: "Reference",
  metaReceivedBy: "Received by",
  columns: { sr: "SR", document: "Applied to invoice", documentDate: "Invoice date", amount: "Amount applied" },
  totalApplied: "Total applied",
  onAccount: "On account",
  previousBalance: "Previous balance",
  remainingBalance: "Remaining balance",
  remainingBalanceUr: "بقایا رقم",
  signatures: ["Received by", "Authorised signature"],
  thanks: "Thank you for your payment.",
  terms: "This receipt is valid subject to realisation of the instrument where applicable.",
} as const;

export const receiptSchema = z.object({
  kind: z.enum(["RECEIPT", "VOUCHER"]),
  /** "PAYMENT RECEIPT" (money in) / "PAYMENT VOUCHER" (money out). */
  title: z.string(),
  paymentId: z.string().uuid(),
  number: z.string(),
  status: z.enum(["Posted", "Reversed"]),
  /** True for a reversed voucher: print it stamped "Reversed", without balances. */
  cancelled: z.boolean(),
  date: z.string(),
  company: companyProfileSchema,
  party: z.object({
    /** "RECEIVED FROM" / "PAID TO". */
    label: z.string(),
    type: z.enum(["CUSTOMER", "SUPPLIER"]),
    id: z.string().uuid(),
    /** What was printed when the voucher was made (a later rename does not change an old receipt). */
    name: z.string().nullable(),
    owner: z.string().nullable(),
    region: z.string().nullable(),
    /** The shop's CURRENT phone (customers only; empty for a supplier). */
    phone: z.string().nullable(),
  }),
  meta: z.object({
    receiptNumber: z.string(),
    method: z.string().nullable(),
    reference: z.string().nullable(),
    receivedBy: z.string().nullable(),
  }),
  /** Where the money went: one row per invoice / purchase; empty means "On account". */
  allocations: z.array(
    z.object({
      documentType: z.enum(["INVOICE", "PURCHASE"]),
      documentId: z.string().uuid(),
      documentNumber: z.string().nullable(),
      documentDate: z.string(),
      amountP: z.number().int(),
    }),
  ),
  totalAppliedP: z.number().int(),
  amountP: z.number().int(),
  /** "Amount received" / "Amount paid". */
  amountLabel: z.string(),
  amountInWords: z.string(),
  /**
   * The party's running balance immediately before / after THIS voucher's row in the statement order, so a reprint
   * next month shows the same figures. Null on a reversed voucher. Sign as in the statement (customer: positive = owes us).
   */
  previousBalanceP: z.number().int().nullable(),
  remainingBalanceP: z.number().int().nullable(),
  notes: z.string().nullable(),
  reversal: z.object({ reason: z.string().nullable(), at: z.string().nullable() }).nullable(),
  labels: z.object({
    meta: z.string(),
    signatures: z.array(z.string()),
    thanks: z.string(),
    terms: z.string(),
  }),
});
export type Receipt = z.infer<typeof receiptSchema>;
