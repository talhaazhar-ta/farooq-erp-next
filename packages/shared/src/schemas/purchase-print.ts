import { z } from "zod";
import { companyProfileSchema } from "./statements.js";

/**
 * The printed purchase (S13): ONE document model, the legacy `DocModel.purchase` (04-documents.js) built on the server from the
 * database. Money is integer paisa with the legacy's own text beside it; dates are `YYYY-MM-DD`. The wording is verbatim in
 * `PURCHASE_PRINT_LABELS` except what fix 4 changed: the legacy printed the ORDERED bags under "Bags received" and in one "Qty"
 * column — here the strip carries "Bags ordered" and "Bags received" separately and the lines have an Ordered and a Received column.
 */

export const PURCHASE_PRINT_LABELS = {
  title: "PURCHASE INVOICE",
  supplier: "SUPPLIER",
  meta: "PURCHASE DETAILS",
  metaRows: { number: "Purchase No", supplierInvoice: "Supplier invoice", date: "Date", warehouse: "Warehouse", vehicle: "Vehicle", driver: "Driver" },
  strip: { paymentStatus: "Payment status", bagsReceived: "Bags received", lines: "Lines", deliveryRef: "Delivery ref" },
  /** New with fix 4 (the legacy had no ordered figure on the sheet). */
  stripOrdered: "Bags ordered",
  columns: [
    { key: "sr", label: "SR", align: "center", width: 0.05 },
    { key: "description", label: "Description", align: "left", width: 0.3 },
    { key: "brand", label: "Brand", align: "left", width: 0.12 },
    { key: "pack", label: "Package", align: "center", width: 0.09 },
    { key: "ordered", label: "Ordered", align: "right", width: 0.09 },
    { key: "received", label: "Received", align: "right", width: 0.09 },
    { key: "rate", label: "Rate", align: "right", width: 0.11 },
    { key: "amount", label: "Amount", align: "right", width: 0.15 },
  ],
  totals: {
    subtotal: "Subtotal",
    discounts: "Discounts",
    /** Not on the legacy sheet (its grand total silently included line tax); drawn only when not zero. */
    tax: "Tax",
    freight: "Freight",
    loading: "Loading / unloading",
    other: "Other charges",
    grand: "Grand total",
    paid: "Paid",
    payable: "Payable to supplier",
  },
  words: "Amount in words",
  payments: "Payments against this document",
  signatures: ["Received by", "Store keeper", "Authorised signature"],
  thanks: "Goods received in good condition unless noted.",
  ribbonCancelled: "CANCELLED",
} as const;

export const purchasePrintSchema = z.object({
  kind: z.literal("PURCHASE"),
  title: z.string(),
  purchaseId: z.string().uuid(),
  number: z.string(),
  /** The payment status as the legacy words it ("Unpaid", "Partly paid", "Paid"). */
  status: z.string(),
  statusKey: z.string(),
  cancelled: z.boolean(),
  date: z.string(),
  company: companyProfileSchema,
  party: z.object({ label: z.string(), supplierId: z.string().uuid().nullable(), name: z.string().nullable() }),
  metaLabel: z.string(),
  /** A row whose value is empty is not drawn (the legacy renderer skipped it). */
  meta: z.array(z.object({ label: z.string(), value: z.string(), strong: z.boolean() })),
  strip: z.array(z.object({ label: z.string(), value: z.string() })),
  columns: z.array(z.object({ key: z.string(), label: z.string(), align: z.string(), width: z.number() })),
  rows: z.array(
    z.object({
      sr: z.number().int(),
      description: z.string(),
      descriptionUr: z.string(),
      brand: z.string(),
      pack: z.string(),
      /** Bags ordered / bags that arrived, as the legacy `qtyFmt` wrote a quantity ("100", "12.5"). */
      ordered: z.string(),
      received: z.string(),
      orderedQuantity: z.number(),
      receivedQuantity: z.number(),
      returnedQuantity: z.number(),
      godown: z.string(),
      rateP: z.number().int(),
      rate: z.string(),
      amountP: z.number().int(),
      amount: z.string(),
    }),
  ),
  itemsFooter: z.object({ description: z.string(), ordered: z.string(), received: z.string(), amount: z.string(), amountP: z.number().int() }),
  /** Subtotal, then only the rows that are not zero, then grand total / paid / payable. */
  totals: z.array(z.object({ key: z.string(), label: z.string(), amountP: z.number().int(), text: z.string(), big: z.boolean(), bold: z.boolean() })),
  totalP: z.number().int(),
  paidP: z.number().int(),
  balanceP: z.number().int(),
  amountInWords: z.string(),
  labels: z.object({ words: z.string(), payments: z.string(), ribbon: z.string() }),
  /** Vouchers applied to this purchase (POSTED only): the amount applied to THIS purchase. */
  payments: z.array(z.object({ paymentId: z.string().uuid(), receiptNumber: z.string(), date: z.string(), method: z.string().nullable(), reference: z.string().nullable(), amountP: z.number().int(), text: z.string() })),
  notes: z.string(),
  signatures: z.array(z.string()),
  footer: z.object({ thanks: z.string() }),
});
export type PurchasePrint = z.infer<typeof purchasePrintSchema>;
