import { z } from "zod";
import { isValidBusinessDate } from "../dates.js";

/**
 * Payments (S3). Request and response shapes shared by apps/api and (from S4) apps/web.
 *
 * - Money is integer paisa (`...P`), never rupees or decimals — the UI converts.
 * - Dates are `YYYY-MM-DD` business dates.
 * - Every request object is `.strict()`: unknown fields are rejected, not ignored.
 * - The user-facing wording of the rules is the legacy wording, kept verbatim (S4 shows it).
 */

/** Sanity cap on a single amount: 10^13 paisa = 10^11 rupees. Far above any real voucher, far below 2^53. */
export const MAX_AMOUNT_P = 10_000_000_000_000;

export const PAYMENT_MESSAGES = {
  amount: "Enter an amount greater than zero.",
  chooseShop: "Choose a shop.",
  chooseSupplier: "Choose a supplier.",
  notFound: "Payment not found.",
  reasonRequired: "Enter a reason.",
} as const;

const amountP = z
  .number({ invalid_type_error: PAYMENT_MESSAGES.amount, required_error: PAYMENT_MESSAGES.amount })
  .int(PAYMENT_MESSAGES.amount)
  .max(MAX_AMOUNT_P, "That amount is too large.");
/** Greater than zero — used everywhere except `editAmount`, where zero/negative is refused by the service *after* the eligibility refusals. */
const positiveAmountP = amountP.gt(0, PAYMENT_MESSAGES.amount);

const businessDate = z.string().refine(isValidBusinessDate, "Enter a valid date (YYYY-MM-DD).");
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} is too long (at most ${max} characters).`).optional();

const uuid = z.string().uuid();
/** A party id that is missing or malformed gets the legacy wording, same as one that names no record. */
const partyId = (message: string) => z.string({ required_error: message, invalid_type_error: message }).uuid(message);

/** Client-chosen key that makes a POST safe to repeat: a second request with the same key returns the first voucher. */
const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, "The idempotency key must be 8-100 letters, digits, '-' or '_'.")
  .optional();

const common = {
  method: optionalText(40, "The method"),
  reference: optionalText(100, "The reference"),
  note: optionalText(500, "The note"),
  date: businessDate.optional(),
  idempotencyKey,
};

export const invoiceAllocationSchema = z.object({ invoiceId: uuid, amountP: positiveAmountP }).strict();
export const purchaseAllocationSchema = z.object({ purchaseId: uuid, amountP: positiveAmountP }).strict();

export const receivePaymentSchema = z
  .object({
    customerId: partyId(PAYMENT_MESSAGES.chooseShop),
    amountP: positiveAmountP,
    /** Omitted / empty = allocate automatically, oldest invoice first. */
    allocations: z.array(invoiceAllocationSchema).max(200).optional(),
    ...common,
  })
  .strict();
export type ReceivePaymentInput = z.infer<typeof receivePaymentSchema>;

export const payPaymentSchema = z
  .object({
    supplierId: partyId(PAYMENT_MESSAGES.chooseSupplier),
    amountP: positiveAmountP,
    /** Optional: purchases this payment settles. */
    allocations: z.array(purchaseAllocationSchema).max(200).optional(),
    ...common,
  })
  .strict();
export type PayPaymentInput = z.infer<typeof payPaymentSchema>;

export const refundPaymentSchema = z
  .object({
    customerId: partyId(PAYMENT_MESSAGES.chooseShop),
    amountP: positiveAmountP,
    ...common,
  })
  .strict();
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;

export const reversePaymentSchema = z
  .object({
    reason: z
      .string({ required_error: PAYMENT_MESSAGES.reasonRequired, invalid_type_error: PAYMENT_MESSAGES.reasonRequired })
      .trim()
      .min(1, PAYMENT_MESSAGES.reasonRequired)
      .max(500, "The reason is too long (at most 500 characters)."),
  })
  .strict();
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

export const editPaymentAmountSchema = z
  .object({
    amountP,
    reason: optionalText(500, "The reason"),
  })
  .strict();
export type EditPaymentAmountInput = z.infer<typeof editPaymentAmountSchema>;

/* ── reads ───────────────────────────────────────────────────────────── */

export const PAYMENT_DIRECTIONS = ["IN", "OUT"] as const;
export const PAYMENT_PARTY_TYPES = ["CUSTOMER", "SUPPLIER"] as const;
export const PAYMENT_STATUSES = ["POSTED", "REVERSED"] as const;

export const listPaymentsQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    direction: z.enum(PAYMENT_DIRECTIONS).optional(),
    partyType: z.enum(PAYMENT_PARTY_TYPES).optional(),
    partyId: uuid.optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    from: businessDate.optional(),
    to: businessDate.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export const partyLookupQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type PartyLookupQuery = z.infer<typeof partyLookupQuerySchema>;

export const paymentAllocationViewSchema = z.object({
  id: z.string().uuid(),
  invoiceId: z.string().uuid().nullable(),
  purchaseId: z.string().uuid().nullable(),
  /** The invoice / purchase number (null for a draft, which has none). */
  documentNumber: z.string().nullable(),
  amountP: z.number().int(),
});
export type PaymentAllocationView = z.infer<typeof paymentAllocationViewSchema>;

export const paymentVoucherSchema = z.object({
  id: z.string().uuid(),
  receiptNumber: z.string(),
  direction: z.enum(PAYMENT_DIRECTIONS),
  partyType: z.enum(PAYMENT_PARTY_TYPES),
  partyId: z.string().uuid(),
  partyName: z.string().nullable(),
  isRefund: z.boolean(),
  amountP: z.number().int(),
  method: z.string().nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  paymentDate: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  receivedBy: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().uuid().nullable(),
  reversedAt: z.string().nullable(),
  reversedBy: z.string().uuid().nullable(),
  reverseReason: z.string().nullable(),
  /** Sum of allocation rows (kept on a reversed voucher for the history; only POSTED vouchers count as paid). */
  allocatedP: z.number().int(),
  /** amountP - allocatedP: money on account that no document absorbed. */
  unallocatedP: z.number().int(),
});
export type PaymentVoucher = z.infer<typeof paymentVoucherSchema>;

export const paymentListItemSchema = paymentVoucherSchema.extend({
  allocationCount: z.number().int(),
});
export type PaymentListItem = z.infer<typeof paymentListItemSchema>;

export const paymentListResponseSchema = z.object({
  items: z.array(paymentListItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type PaymentListResponse = z.infer<typeof paymentListResponseSchema>;

export const paymentActionSchema = z.object({
  allowed: z.boolean(),
  /** Why the action is refused — the same wording the write endpoint would return. Null when allowed. */
  reason: z.string().nullable(),
});
export type PaymentAction = z.infer<typeof paymentActionSchema>;

export const paymentDetailSchema = paymentVoucherSchema.extend({
  allocations: z.array(paymentAllocationViewSchema),
  actions: z.object({ reverse: paymentActionSchema, editAmount: paymentActionSchema }),
});
export type PaymentDetail = z.infer<typeof paymentDetailSchema>;

export const partyLookupItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  contact: z.string().nullable(),
  phone: z.string().nullable(),
  region: z.string().nullable(),
  active: z.boolean(),
});
export type PartyLookupItem = z.infer<typeof partyLookupItemSchema>;

export const partyBalanceSchema = z.object({
  partyId: z.string().uuid(),
  /** Customers: positive = the shop owes us. Suppliers: positive = we owe the supplier. From the journal. */
  balanceP: z.number().int(),
});
export type PartyBalance = z.infer<typeof partyBalanceSchema>;

export const outstandingDocumentSchema = z.object({
  id: z.string().uuid(),
  number: z.string().nullable(),
  date: z.string(),
  status: z.string(),
  totalP: z.number().int(),
  /** Allocations of POSTED payments. */
  paidP: z.number().int(),
  /** Customer invoices only: credit of non-cancelled returns linked to the invoice. Always 0 for purchases. */
  creditP: z.number().int(),
  outstandingP: z.number().int(),
});
export type OutstandingDocument = z.infer<typeof outstandingDocumentSchema>;

/** Body of every 4xx business-rule / validation refusal (HTTP 422). */
export const businessRuleErrorSchema = z.object({
  message: z.string(),
  errors: z.array(z.string()),
});
export type BusinessRuleErrorBody = z.infer<typeof businessRuleErrorSchema>;
