import { z } from "zod";
import { isValidBusinessDate } from "../dates.js";
import { MAX_AMOUNT_P } from "../money.js";

/**
 * Supplier purchases (S12). Request and response shapes shared by apps/api and (from S13) apps/web.
 *
 * - Money is integer paisa (`...P`); a quantity is a decimal number of bags with at most 3 decimals on the way in, and comes
 *   back as both a decimal and exact integer thousandths (`...Milli`).
 * - Dates are `YYYY-MM-DD` business dates. Every request object is `.strict()`.
 * - The wording of the rules is the legacy wording (02-services.js `Validate.purchase`, `Purchases.editErrors`, `Purchases.save`),
 *   kept verbatim; the messages that are new (owner decisions, stale edit, discount above the line) say what to do next.
 * - There are no purchase drafts, no cancel and no delete (owner decision 2026-09-25): a saved purchase is ORDERED,
 *   PARTIALLY_RECEIVED or RECEIVED from the bags its lines received.
 */

/** Legacy messages verbatim, and the new ones next to them. */
export const PURCHASE_MESSAGES = {
  // Validate.purchase
  chooseSupplier: "Choose a supplier.",
  chooseWarehouse: "Choose the destination warehouse.",
  noLines: "Add at least one product line.",
  // Purchases.editErrors / save
  notFound: "Purchase not found.",
  cancelledEdit: "A cancelled purchase cannot be edited.",
  overpaid: "The amount paid is more than the purchase total. Record the extra as a separate payment to the supplier.",
  // new in S12 (owner decisions 2026-09-25 and the planner's rules)
  paidNegative: "The amount paid cannot be negative.",
  stale: "This purchase was changed by someone else since you opened it. Reload it and make your change again.",
  revisionRequired: "Reload the purchase and try again: the request did not say which version of the purchase was edited.",
  noPermissionCreate: "You do not have permission to record purchases.",
  noPermissionEdit: "You do not have permission to edit a purchase.",
  noPermissionPayment: "You do not have permission to pay a supplier. Clear the amount paid, or ask someone who can record payments.",
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

/** Client-chosen key that makes a save safe to repeat: a second request with the same key returns the first result. */
const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, "The idempotency key must be 8-100 letters, digits, '-' or '_'.")
  .optional();

/* ── writes ──────────────────────────────────────────────────────────── */

export const purchaseLineInputSchema = z
  .object({
    /** The id of an existing line of this purchase when it is being edited (keeps the line's identity); omit for a new line. */
    id: uuid.optional(),
    productId: idOrMessage("Choose a product on every line."),
    /** The bags ORDERED, at most 3 decimals. */
    quantity: z.number({ invalid_type_error: "Every line needs a quantity.", required_error: "Every line needs a quantity." }).finite("Every line needs a quantity."),
    /** The bags that ARRIVED. Absent = the whole line arrived (the legacy blank); 0 = nothing arrived (an order); less than `quantity` = a part delivery. */
    receivedQuantity: z.number().finite("Received bags must be a number.").optional(),
    unitPriceP: moneyField("The rate"),
    discountP: moneyField("The discount").optional(),
    /** Tax as a percent of the taxable amount (legacy `taxRate`); wins over `taxP` when non-zero. */
    taxRatePct: z.number().finite().min(0, "The tax rate cannot be negative.").max(100, "The tax rate cannot be more than 100%.").optional(),
    /** A fixed tax in paisa (the saved shape of a line; used when there is no rate). */
    taxP: moneyField("The tax").optional(),
    /** The godown this line goes to; defaults to the purchase's warehouse. */
    warehouseId: uuid.optional(),
    unit: optionalText(20, "The unit"),
    batchNo: optionalText(60, "The batch number"),
    notes: optionalText(300, "The line note"),
  })
  .strict();
export type PurchaseLineInputShape = z.infer<typeof purchaseLineInputSchema>;

export const savePurchaseSchema = z
  .object({
    supplierId: idOrMessage(PURCHASE_MESSAGES.chooseSupplier),
    /** The header's default godown (a line may name its own). */
    warehouseId: idOrMessage(PURCHASE_MESSAGES.chooseWarehouse),
    /** Defaults to today's business date on a new purchase and to the recorded date on an edit; may be in the past. */
    date: businessDate.optional(),
    supplierInvoiceNo: optionalText(100, "The supplier's bill number"),
    vehicleNo: optionalText(40, "The vehicle number"),
    driver: optionalText(100, "The driver"),
    deliveryRef: optionalText(100, "The delivery reference"),
    lines: z.array(purchaseLineInputSchema).max(200, "A purchase can have at most 200 lines."),
    /** The overall discount (line discounts are on the lines). */
    invoiceDiscountP: moneyField("The discount").optional(),
    freightP: moneyField("The freight").optional(),
    loadingP: moneyField("The loading charge").optional(),
    otherChargesP: moneyField("The other charges").optional(),
    /** What is paid to the supplier with this bill. New: default 0. Editing: default = what is already paid; it can only be raised. */
    paidAmountP: z
      .number({ invalid_type_error: "The amount paid must be a number of paisa." })
      .int("The amount paid must be a whole number of paisa.")
      .min(-MAX_AMOUNT_P, "That amount is too large.")
      .max(MAX_AMOUNT_P, "That amount is too large.")
      .optional(),
    paymentMethod: optionalText(40, "The payment method"),
    notes: optionalText(1000, "The notes"),
    description: optionalText(1000, "The description"),
    /** Editing (PUT) only: the `revision` of the purchase as the client loaded it. A mismatch is refused. */
    revision: z.number().int().min(0).optional(),
    idempotencyKey,
  })
  .strict();
export type SavePurchaseInput = z.infer<typeof savePurchaseSchema>;

/* ── reads ───────────────────────────────────────────────────────────── */

export const PURCHASE_PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID"] as const;

const action = z.object({ allowed: z.boolean(), reason: z.string().nullable() });
export type PurchaseAction = z.infer<typeof action>;

export const purchaseLineSchema = z.object({
  id: z.string().uuid(),
  sortOrder: z.number().int(),
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  description: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  brand: z.string().nullable(),
  package: z.string().nullable(),
  unit: z.string(),
  /** Bags ordered. */
  quantity: z.number(),
  qtyMilli: z.number().int(),
  /** Bags that arrived. */
  receivedQuantity: z.number(),
  receivedQtyMilli: z.number().int(),
  returnedQuantity: z.number(),
  unitPriceP: z.number().int(),
  discountP: z.number().int(),
  taxP: z.number().int(),
  lineTotalP: z.number().int(),
  batchNo: z.string().nullable(),
  notes: z.string().nullable(),
  /** PROFIT_VIEW only: the cost figures the save wrote (`allocateCharges`) — the keys do not exist for anyone else. */
  goodsUnitCostP: z.number().int().nullable().optional(),
  chargeShareP: z.number().int().nullable().optional(),
  landedUnitCostP: z.number().int().nullable().optional(),
  operationalShareP: z.number().int().nullable().optional(),
});
export type PurchaseLine = z.infer<typeof purchaseLineSchema>;

export const purchasePaymentSchema = z.object({
  paymentId: z.string().uuid(),
  receiptNumber: z.string(),
  date: z.string(),
  method: z.string().nullable(),
  reference: z.string().nullable(),
  /** The part of the voucher applied to THIS purchase. */
  allocatedP: z.number().int(),
  status: z.enum(["POSTED", "REVERSED"]),
});

export const purchaseStockMovementSchema = z.object({
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
  /** PROFIT_VIEW only. */
  unitCostP: z.number().int().nullable().optional(),
});

export const purchaseDetailSchema = z.object({
  id: z.string().uuid(),
  number: z.string().nullable(),
  status: z.string(),
  paymentStatus: z.enum(PURCHASE_PAYMENT_STATUSES),
  date: z.string(),
  supplierId: z.string().uuid().nullable(),
  /** What the bill printed about the supplier when it was made (a later rename does not change it). */
  supplierName: z.string().nullable(),
  supplierInvoiceNo: z.string().nullable(),
  warehouseId: z.string().uuid().nullable(),
  warehouseName: z.string().nullable(),
  vehicleNo: z.string().nullable(),
  driver: z.string().nullable(),
  deliveryRef: z.string().nullable(),
  subtotalP: z.number().int(),
  /** Σ line discounts. */
  itemDiscountsP: z.number().int(),
  /** The overall discount: the header's one discount figure minus the line discounts (the legacy `toDraft`). */
  invoiceDiscountP: z.number().int(),
  /** Line + overall discount, the one figure the legacy header keeps. */
  discountAmountP: z.number().int(),
  taxP: z.number().int(),
  freightP: z.number().int(),
  loadingP: z.number().int(),
  otherChargesP: z.number().int(),
  /** The grand total — what posts to PURCHASES / PAYABLES. */
  totalP: z.number().int(),
  /** Paid against this bill (allocations of POSTED vouchers). */
  paidP: z.number().int(),
  balanceP: z.number().int(),
  notes: z.string().nullable(),
  description: z.string().nullable(),
  orderedQuantity: z.number(),
  receivedQuantity: z.number(),
  lineCount: z.number().int(),
  stockApplied: z.boolean(),
  migrated: z.boolean(),
  revision: z.number().int(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lines: z.array(purchaseLineSchema),
  payments: z.array(purchasePaymentSchema),
  stockMovements: z.array(purchaseStockMovementSchema),
  /** What this role may do now, and why not (the server's own wording — show it). */
  actions: z.object({
    edit: action,
    /** (S13) Whether the supplier on this purchase may be swapped in an edit, and why not (a voucher or a supplier return is attached — the legacy sentence). */
    changeSupplier: action,
  }),
  /** (S13) The supplier's name now (the bill keeps what it printed in `supplierName`). */
  supplierCurrentName: z.string().nullable(),
  /** (S13) The supplier's whole balance now (positive = we owe them), from the journal; null without a supplier. */
  supplierBalanceP: z.number().int().nullable(),
  /**
   * PROFIT_VIEW only — the key does not exist for anyone else: the cost basis in force and, per product × godown this purchase
   * touches, the average and last cost the stock row carries now.
   */
  costs: z
    .object({
      basis: z.enum(["LANDED", "PURCHASE"]),
      stock: z.array(z.object({ productId: z.string().uuid(), warehouseId: z.string().uuid(), avgCostP: z.number().int(), lastCostP: z.number().int() })),
    })
    .optional(),
});
export type PurchaseDetail = z.infer<typeof purchaseDetailSchema>;

/* ── the builder's "last rate" picker ────────────────────────────────── */

export const purchaseRatesQuerySchema = z
  .object({
    /** Comma-separated product ids, at most 100. */
    productIds: z.preprocess(
      (v) => (v === "" || v === undefined ? undefined : String(v).split(",").map((s) => s.trim()).filter(Boolean)),
      z.array(uuid).min(1, "Name at least one product.").max(100),
    ),
  })
  .strict();
export type PurchaseRatesQuery = z.infer<typeof purchaseRatesQuerySchema>;

/** The rate of the most recent non-cancelled purchase line of each product (legacy "last purchase rate"). */
export const purchaseRateSchema = z.object({
  productId: z.string().uuid(),
  unitPriceP: z.number().int(),
  date: z.string(),
  purchaseNumber: z.string().nullable(),
  supplierId: z.string().uuid().nullable(),
});
export type PurchaseRate = z.infer<typeof purchaseRateSchema>;
