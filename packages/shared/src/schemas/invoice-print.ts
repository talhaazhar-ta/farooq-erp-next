import { z } from "zod";
import { companyProfileSchema } from "./statements.js";

/**
 * The printed sales invoice (S8): ONE document model that both the classic and the standard layout render — the legacy
 * `DocModel.invoice` (04-documents.js) plus the `classic` block of 08-classic-invoice.js. Built on the server from the
 * database, never from a form. Money is integer paisa (`...P`) with the legacy's own text next to it where the legacy
 * formatted it (`text`); dates are `YYYY-MM-DD` (the screen writes them "05 Sep 2026" / "05/09/2026"); the wording is the
 * legacy wording, verbatim, in `INVOICE_PRINT_LABELS` / `CLASSIC_LABELS` — S9 prints these, it does not retype them.
 */

export const INVOICE_TEMPLATES = ["classic", "standard"] as const;
export type InvoiceTemplate = (typeof INVOICE_TEMPLATES)[number];

export const invoicePrintQuerySchema = z
  .object({ template: z.preprocess((v) => (v === "" ? undefined : v), z.enum(INVOICE_TEMPLATES).optional()) })
  .strict();
export type InvoicePrintQuery = z.infer<typeof invoicePrintQuerySchema>;

/** 04-documents.js `DocModel.invoice`, verbatim. */
export const INVOICE_PRINT_LABELS = {
  title: "INVOICE",
  draftNumber: "DRAFT",
  notIssued: "Not issued (draft)",
  billTo: "BILL TO",
  billToUr: "بنام",
  meta: "INVOICE DETAILS",
  metaRows: {
    number: "Invoice No",
    type: "Invoice type",
    date: "Invoice date",
    dueDate: "Due date",
    order: "Order No",
    dispatch: "Dispatch No",
    warehouse: "Warehouse",
    paymentStatus: "Payment status",
    salesperson: "Salesperson",
  },
  saleType: "Sales invoice",
  strip: { method: "Payment method", reference: "Reference", region: "Region", items: "Items" },
  columns: [
    { key: "sr", label: "SR", align: "center", width: 0.05 },
    { key: "description", label: "Description", align: "left", width: 0.3 },
    { key: "brand", label: "Brand", align: "left", width: 0.13 },
    { key: "pack", label: "Package", align: "center", width: 0.09 },
    { key: "qty", label: "Qty", align: "right", width: 0.08 },
    { key: "rate", label: "Rate", align: "right", width: 0.11 },
    { key: "discount", label: "Discount", align: "right", width: 0.11 },
    { key: "amount", label: "Amount", align: "right", width: 0.13 },
  ],
  totals: {
    subtotal: "Subtotal",
    itemDiscounts: "Item discounts",
    invoiceDiscount: "Invoice discount",
    tax: "Tax",
    freight: "Delivery / freight",
    loading: "Loading / unloading",
    other: "Other charges",
    grand: "Grand total",
    grandUr: "ٹوٹل بل رقم",
    paid: "Amount Paid",
    paidUr: "نقد وصول",
    balance: "Balance on this invoice",
    balanceUr: "بقایا رقم",
  },
  words: "Amount in words",
  ledger: {
    previous: "Previous balance",
    previousUr: "سابقہ بقایا رقم",
    thisInvoice: "This invoice",
    received: "Payment received",
    current: "Current outstanding balance",
    currentUr: "بقایا رقم",
  },
  signatures: ["Prepared by", "Received by (shopkeeper)", "Authorised signature"],
  thanks: "Thank you for your business.",
  ribbonCancelled: "CANCELLED",
  ribbonDraft: "DRAFT",
} as const;

/** 08-classic-invoice.js, verbatim. */
export const CLASSIC_LABELS = {
  phoneMobileUr: "موبائیل نمبر: ",
  phoneShopUr: "فون دکان: ",
  trademarkUr: "ٹریڈمارک",
  billToParty: "Bill to Party",
  serial: "Invoice #:",
  invNo: "InvNo",
  date: "Invoice Date",
  idNo: "ID #",
  ledger: { date: "Date", dateUr: "تاریخ", dr: "Dr", drUr: "بنام رقم", cr: "Cr", crUr: "وصولی", subtotal: "Subtotal:", none: "No earlier entries" },
  products: { product: "Product", price: "Price", quantity: "Quantity", amounts: "Amounts", subtotal: "Subtotal:" },
  remarks: "Remarks: ",
  /** [English label, Urdu label] of the six rows of the totals box, in order; the fifth is blank on the shop's own sheet. */
  box: [
    ["Gross Amounts:", "سب ٹوٹل"],
    ["Opening", "سابقہ بقایا رقم"],
    ["Total :", "ٹوٹل بل رقم"],
    ["Cash Amt:", "نقد وصول"],
    ["", ""],
    ["Balance", "بقایا رقم"],
  ],
} as const;

const textRow = z.object({ label: z.string(), value: z.string() });

export const invoicePrintSchema = z.object({
  kind: z.literal("INVOICE"),
  title: z.string(),
  invoiceId: z.string().uuid(),
  /** The invoice number, or "DRAFT" for a draft (which has none). */
  number: z.string(),
  hasNumber: z.boolean(),
  /** The status as the legacy words it ("Partly paid") and as stored. */
  status: z.string(),
  statusKey: z.string(),
  isDraft: z.boolean(),
  /** True for a cancelled invoice: print it stamped. */
  cancelled: z.boolean(),
  date: z.string(),
  /** Which layout to draw: the `template` asked for, else the business's own setting (classic unless set otherwise). */
  template: z.enum(INVOICE_TEMPLATES),
  company: companyProfileSchema,
  party: z.object({
    label: z.string(),
    labelUr: z.string(),
    customerId: z.string().uuid().nullable(),
    shop: z.string().nullable(),
    owner: z.string().nullable(),
    code: z.string().nullable(),
    contact: z.string().nullable(),
    whatsapp: z.string().nullable(),
    address: z.string().nullable(),
    region: z.string().nullable(),
    market: z.string().nullable(),
  }),
  metaLabel: z.string(),
  /** Label / value (`strong`: drawn bold — the invoice number); a row whose value is empty is not drawn (the legacy renderer skips it). */
  meta: z.array(textRow.extend({ strong: z.boolean() })),
  strip: z.array(textRow),
  columns: z.array(z.object({ key: z.string(), label: z.string(), align: z.string(), width: z.number() })),
  rows: z.array(
    z.object({
      sr: z.number().int(),
      /** The English name (the legacy `description`), and the Urdu one (`descriptionUr`). */
      description: z.string(),
      descriptionUr: z.string(),
      brand: z.string(),
      pack: z.string(),
      /** "200 Bags" — quantity, unit and a plural s unless exactly one. */
      qty: z.string(),
      quantity: z.number(),
      rateP: z.number().int(),
      rate: z.string(),
      discountP: z.number().int(),
      /** "—" when there is no discount. */
      discount: z.string(),
      amountP: z.number().int(),
      amount: z.string(),
      returned: z.number(),
      batch: z.string(),
    }),
  ),
  itemsFooter: z.object({ description: z.string(), qty: z.string(), amount: z.string(), amountP: z.number().int() }),
  /** Subtotal, then only the rows that are not zero, then grand total / paid / balance on this invoice. */
  totals: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      labelUr: z.string().nullable(),
      amountP: z.number().int(),
      /** As the legacy printed it: "PKR 27,425" (a discount carries "− "). */
      text: z.string(),
      big: z.boolean(),
      bold: z.boolean(),
      rule: z.boolean(),
    }),
  ),
  totalP: z.number().int(),
  paidP: z.number().int(),
  balanceP: z.number().int(),
  amountInWords: z.string(),
  labels: z.object({
    words: z.string(),
    ledger: z.object({ previous: z.string(), previousUr: z.string(), thisInvoice: z.string(), received: z.string(), current: z.string(), currentUr: z.string() }),
    ribbon: z.object({ cancelled: z.string(), draft: z.string() }),
  }),
  /** Receipts applied to this invoice (POSTED only): date, method, reference, the amount applied to THIS invoice. */
  payments: z.array(z.object({ paymentId: z.string().uuid(), receiptNumber: z.string(), date: z.string(), method: z.string().nullable(), reference: z.string().nullable(), amountP: z.number().int(), text: z.string() })),
  notes: z.string(),
  /** Previous balance (frozen when the invoice was posted), this invoice, payment received, current outstanding (live). Signed: positive = the shop owes us. */
  ledger: z.array(z.object({ label: z.string(), labelUr: z.string(), text: z.string(), amountP: z.number().int() })),
  previousBalanceP: z.number().int(),
  currentBalanceP: z.number().int().nullable(),
  signatures: z.array(z.string()),
  footer: z.object({ thanks: z.string(), terms: z.string(), bank: z.string() }),
  /** The classic layout's extra figures (08-classic-invoice.js `classicBlock`). Always present, whatever the template. */
  classic: z.object({
    /** The trailing digits of the invoice number (0 for a draft; the sheet prints "—"). */
    serial: z.number().int(),
    /** `<salesDocPrefix>-` and the serial to six digits: "SLV-000123". */
    invNo: z.string(),
    idNo: z.string(),
    contact: z.string(),
    regionUr: z.string(),
    remarks: z.string(),
    /** The shop's last six account entries up to and including this invoice; Dr / Cr as plain figures ("0" when none). */
    ledgerRows: z.array(z.object({ date: z.string(), drP: z.number().int(), crP: z.number().int(), dr: z.string(), cr: z.string() })),
    ledgerTotals: z.object({ drP: z.number().int(), crP: z.number().int(), dr: z.string(), cr: z.string() }),
    box: z.array(z.object({ label: z.string(), labelUr: z.string(), amountP: z.number().int(), text: z.string(), big: z.boolean() })),
    qtyTotal: z.number(),
    lineTotalP: z.number().int(),
    lineTotal: z.string(),
    /** "موبائیل نمبر: 0300…", "فون دکان: …", the proprietor — the header's phone line. */
    phones: z.array(z.string()),
  }),
});
export type InvoicePrint = z.infer<typeof invoicePrintSchema>;
