import { z } from "zod";
import { isValidBusinessDate } from "../dates.js";
import { MAX_AMOUNT_P } from "../money.js";

/**
 * Sales invoices (S7). Request and response shapes shared by apps/api and (from S9) apps/web.
 *
 * - Money is integer paisa (`...P`); a quantity is a decimal number of bags with at most 3 decimals (`quantity`) on the
 *   way in, and comes back as both `quantity` and exact integer thousandths (`qtyMilli`).
 * - Dates are `YYYY-MM-DD` business dates.
 * - Every request object is `.strict()`: unknown fields are rejected, not ignored.
 * - The wording of the rules is the legacy wording (02-services.js `Validate.invoice`, `Invoices.*`, 06-wiring.js), kept
 *   verbatim; the messages that are new (owner decisions, stale edit, lowered paid, return / dispatch guard) say what to do next.
 */

/** Legacy messages verbatim, and the new ones next to them. */
export const INVOICE_MESSAGES = {
  // Validate.invoice
  chooseShop: "Choose a shop to invoice.",
  chooseWarehouse: "Choose the warehouse the bags leave from.",
  noLines: "Add at least one product line.",
  paidNegative: "The amount paid cannot be negative.",
  overpaid: "The amount paid is more than the invoice total. Record the extra as a separate payment on account.",
  // 06-wiring.js / Invoices.save / reassignCheck
  notFound: "Invoice not found.",
  cancelledEdit: "A cancelled invoice cannot be edited. Duplicate it instead.",
  shopLockedOnEdit:
    "The shop on a posted invoice cannot be changed while editing it. " + 'Use "Change shop" on the invoice, which moves its payments with it.',
  cancelledMove: "A cancelled invoice cannot be moved to another shop.",
  draftMove: "This invoice is still a draft — edit it and pick the other shop.",
  chooseNewShop: "Choose the shop this invoice belongs to.",
  sameShop: "That is already the shop on this invoice.",
  // new in S7 (owner decisions 2026-09-24 and the planner's rules)
  reasonRequired: "Enter a reason for cancelling this invoice.",
  alreadyCancelled: "This invoice is already cancelled.",
  toDraft: "A posted invoice cannot be turned back into a draft. Save your changes as a posted invoice, or cancel the invoice.",
  stale: "This invoice was changed by someone else since you opened it. Reload it and make your change again.",
  revisionRequired: "Reload the invoice and try again: the request did not say which version of the invoice was edited.",
  paymentOnDraft: "Payment can only be taken when the invoice is posted. Clear the amount paid, or post the invoice.",
  noPermissionPost: "You do not have permission to create or post invoices.",
  noPermissionCorrect: "You do not have permission to edit a posted invoice, cancel it or change its shop.",
  noPermissionPayment: "You do not have permission to take payment. Clear the amount paid, or ask someone who can record payments.",
} as const;

const businessDate = z.string().refine(isValidBusinessDate, "Enter a valid date (YYYY-MM-DD).");
const optionalText = (max: number, label: string) => z.string().trim().max(max, `${label} is too long (at most ${max} characters).`).optional();
const uuid = z.string().uuid();
const idOrMessage = (message: string) => z.string({ required_error: message, invalid_type_error: message }).uuid(message);

const moneyField = (label: string) =>
  z
    .number({ invalid_type_error: `${label} must be a number of paisa.`, required_error: `${label} is required.` })
    .int(`${label} must be a whole number of paisa.`)
    .min(-MAX_AMOUNT_P, "That amount is too large.")
    .max(MAX_AMOUNT_P, "That amount is too large.");

/** Client-chosen key that makes a save safe to repeat: a second request with the same key returns the first result (same rule as payments). */
const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, "The idempotency key must be 8-100 letters, digits, '-' or '_'.")
  .optional();

/* ── writes ──────────────────────────────────────────────────────────── */

export const invoiceLineInputSchema = z
  .object({
    /** The id of an existing line of this invoice when it is being edited (keeps the line's identity); omit for a new line. */
    id: uuid.optional(),
    productId: idOrMessage("Choose a product on every line."),
    /** Bags, at most 3 decimals (2.5 = two and a half bags). Checked with the line number by the service. */
    quantity: z.number({ invalid_type_error: "Every line needs a quantity.", required_error: "Every line needs a quantity." }).finite("Every line needs a quantity."),
    unitPriceP: moneyField("The rate"),
    discountP: moneyField("The discount").optional(),
    /** Tax as a percent of the taxable amount (legacy `taxRate`); wins over `taxP` when non-zero. */
    taxRatePct: z.number().finite().min(0, "The tax rate cannot be negative.").max(100, "The tax rate cannot be more than 100%.").optional(),
    /** A fixed tax in paisa (the saved shape of a line; used when there is no rate). */
    taxP: moneyField("The tax").optional(),
    /** The godown this line leaves from; defaults to the invoice's warehouse. */
    warehouseId: uuid.optional(),
    unit: optionalText(20, "The unit"),
    batchNo: optionalText(60, "The batch number"),
    notes: optionalText(300, "The line note"),
  })
  .strict();
export type InvoiceLineInputShape = z.infer<typeof invoiceLineInputSchema>;

export const SAVE_MODES = ["draft", "post"] as const;

export const saveInvoiceSchema = z
  .object({
    /** `draft`: no number, no stock, no journal, no payment. `post`: the invoice is issued. */
    mode: z.enum(SAVE_MODES, { errorMap: () => ({ message: "Say whether to save a draft or post the invoice." }) }),
    customerId: idOrMessage(INVOICE_MESSAGES.chooseShop),
    warehouseId: idOrMessage(INVOICE_MESSAGES.chooseWarehouse),
    /** Defaults to today's business date; may be in the past. */
    date: businessDate.optional(),
    dueDate: businessDate.optional(),
    lines: z.array(invoiceLineInputSchema).max(200, "An invoice can have at most 200 lines."),
    invoiceDiscountP: moneyField("The invoice discount").optional(),
    freightP: moneyField("The freight").optional(),
    loadingP: moneyField("The loading charge").optional(),
    otherChargesP: moneyField("The other charges").optional(),
    /** What is paid at the time of sale. New invoice: default 0. Editing a posted invoice: default = what is already received. */
    paidAmountP: z
      .number({ invalid_type_error: "The amount paid must be a number of paisa." })
      .int("The amount paid must be a whole number of paisa.")
      .min(-MAX_AMOUNT_P, "That amount is too large.")
      .max(MAX_AMOUNT_P, "That amount is too large.")
      .optional(),
    paymentMethod: optionalText(40, "The payment method"),
    referenceNo: optionalText(100, "The reference"),
    notes: optionalText(1000, "The notes"),
    description: optionalText(1000, "The description"),
    salesperson: optionalText(100, "The salesperson"),
    orderNumber: optionalText(60, "The order number"),
    /** Editing (PUT) only: the `revision` of the invoice as the client loaded it. A mismatch is refused. */
    revision: z.number().int().min(0).optional(),
    idempotencyKey,
  })
  .strict();
export type SaveInvoiceInput = z.infer<typeof saveInvoiceSchema>;

export const cancelInvoiceSchema = z
  .object({
    reason: z
      .string({ required_error: INVOICE_MESSAGES.reasonRequired, invalid_type_error: INVOICE_MESSAGES.reasonRequired })
      .trim()
      .min(1, INVOICE_MESSAGES.reasonRequired)
      .max(500, "The reason is too long (at most 500 characters)."),
  })
  .strict();
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;

export const changeInvoiceShopSchema = z
  .object({
    customerId: idOrMessage(INVOICE_MESSAGES.chooseNewShop),
    reason: optionalText(500, "The reason"),
  })
  .strict();
export type ChangeInvoiceShopInput = z.infer<typeof changeInvoiceShopSchema>;

export const duplicateInvoiceSchema = z.object({ idempotencyKey }).strict();
export type DuplicateInvoiceInput = z.infer<typeof duplicateInvoiceSchema>;

/* ── reads ───────────────────────────────────────────────────────────── */

export const INVOICE_PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID"] as const;

const action = z.object({ allowed: z.boolean(), reason: z.string().nullable() });
export type InvoiceAction = z.infer<typeof action>;

export const invoiceLineSchema = z.object({
  id: z.string().uuid(),
  sortOrder: z.number().int(),
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  description: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  package: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string(),
  quantity: z.number(),
  qtyMilli: z.number().int(),
  unitPriceP: z.number().int(),
  discountP: z.number().int(),
  taxP: z.number().int(),
  lineTotalP: z.number().int(),
  returnedQuantity: z.number(),
  /** What one bag cost us when this was sold. Present only for a role with PROFIT_VIEW, `null` otherwise (and when the legacy had none). */
  costSnapshotP: z.number().int().nullable(),
  batchNo: z.string().nullable(),
  notes: z.string().nullable(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceReceiptSchema = z.object({
  paymentId: z.string().uuid(),
  receiptNumber: z.string(),
  date: z.string(),
  method: z.string().nullable(),
  reference: z.string().nullable(),
  /** The part of the receipt applied to THIS invoice. */
  allocatedP: z.number().int(),
  status: z.enum(["POSTED", "REVERSED"]),
});

export const invoiceStockMovementSchema = z.object({
  id: z.string().uuid(),
  date: z.string(),
  kind: z.string(),
  refType: z.string().nullable(),
  ref: z.string().nullable(),
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  bucket: z.string(),
  quantity: z.number(),
  note: z.string().nullable(),
});

export const invoiceDetailSchema = z.object({
  id: z.string().uuid(),
  number: z.string().nullable(),
  status: z.string(),
  paymentStatus: z.enum(INVOICE_PAYMENT_STATUSES),
  invoiceType: z.string(),
  date: z.string(),
  dueDate: z.string().nullable(),
  customerId: z.string().uuid().nullable(),
  /** What the invoice printed about the shop when it was made (a later rename does not change it). */
  shop: z.object({
    code: z.string().nullable(),
    name: z.string().nullable(),
    shopName: z.string().nullable(),
    contactPerson: z.string().nullable(),
    mobile: z.string().nullable(),
    whatsapp: z.string().nullable(),
    address: z.string().nullable(),
    regionId: z.string().uuid().nullable(),
    region: z.string().nullable(),
    market: z.string().nullable(),
  }),
  warehouseId: z.string().uuid().nullable(),
  warehouseName: z.string().nullable(),
  salesperson: z.string().nullable(),
  orderNumber: z.string().nullable(),
  dispatchNumber: z.string().nullable(),
  subtotalP: z.number().int(),
  itemDiscountsP: z.number().int(),
  invoiceDiscountP: z.number().int(),
  discountAmountP: z.number().int(),
  taxP: z.number().int(),
  freightP: z.number().int(),
  loadingP: z.number().int(),
  otherChargesP: z.number().int(),
  /** The grand total. */
  totalP: z.number().int(),
  /** Received against this invoice (allocations of POSTED receipts). */
  paidP: z.number().int(),
  /** total − paid. */
  balanceP: z.number().int(),
  /** total − paid − credit of non-cancelled customer returns (the legacy `Invoices.outstanding`). */
  outstandingP: z.number().int(),
  paymentMethod: z.string().nullable(),
  referenceNo: z.string().nullable(),
  notes: z.string().nullable(),
  description: z.string().nullable(),
  /** The shop's balance before this sale, frozen when it was posted (signed: positive = the shop owed us). */
  previousBalanceP: z.number().int(),
  totalQuantity: z.number(),
  lineCount: z.number().int(),
  stockApplied: z.boolean(),
  migrated: z.boolean(),
  revision: z.number().int(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  lines: z.array(invoiceLineSchema),
  receipts: z.array(invoiceReceiptSchema),
  stockMovements: z.array(invoiceStockMovementSchema),
  /** What this role may do now, and why not (the server's own wording — show it). */
  actions: z.object({ edit: action, cancel: action, changeShop: action, duplicate: action }),
});
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;

/* ── pickers (the invoice builder) ───────────────────────────────────── */

export const productPickQuerySchema = z
  .object({
    q: z.preprocess((v) => (v === "" ? undefined : v), z.string().max(100).optional()),
    /** The warehouse whose "available" figure sorts in-stock products first. */
    warehouseId: z.preprocess((v) => (v === "" ? undefined : v), uuid.optional()),
    limit: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(1).max(100).default(40)),
  })
  .strict();
export type ProductPickQuery = z.infer<typeof productPickQuerySchema>;

export const productPickItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  nameEn: z.string().nullable(),
  nameUr: z.string().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  unit: z.string().nullable(),
  weightKg: z.number().nullable(),
  sku: z.string().nullable(),
  /** The owner's set selling price (Prices panel), else null. */
  sellP: z.number().int().nullable(),
  minSellP: z.number().int().nullable(),
  /** The rate of the most recent posted, non-cancelled invoice line for this product, else null — the fallback when no price is set. */
  lastRateP: z.number().int().nullable(),
  taxPct: z.number().nullable(),
  /** Bags in the sellable bucket, per warehouse, in bags (not thousandths). */
  available: z.array(z.object({ warehouseId: z.string().uuid(), quantity: z.number() })),
  /** PROFIT_VIEW only (null otherwise): the cost the next sale of one bag would be given, and the price-panel buy price. */
  costP: z.number().int().nullable(),
  buyP: z.number().int().nullable(),
});
export type ProductPickItem = z.infer<typeof productPickItemSchema>;

export const warehouseItemSchema = z.object({ id: z.string().uuid(), name: z.string(), active: z.boolean() });
export type WarehouseItem = z.infer<typeof warehouseItemSchema>;
