/**
 * Invoice arithmetic — a literal port of the legacy `Calc.line` / `Calc.invoice` / `Calc.paymentStatus`
 * (`erp-upgrade/02-services.js` ~242-285). One function serves the importer's reconciliation check, S7's
 * invoice service and S9's live preview, so a total can never be computed two ways.
 *
 * Money is integer paisa. QUANTITIES ARE INTEGER THOUSANDTHS (`qtyMilli`, 2.5 bags = 2500): the legacy rounds
 * every quantity to 3 decimals (`Money.qty`), so carrying thousandths makes that rounding exact and keeps
 * sums of quantities free of float drift. Convert at the edge with `qtyToMilli` / `milliToQty`.
 *
 * What is ported exactly (the quirks are deliberate — the old app's saved totals are the truth to match):
 *   gross          = Math.round(unitPriceP × qty)          (float multiply, like `Money.mul`; no whole-invoice rounding)
 *   line discount  = min(discountP, gross)                 (capped at the gross)
 *   line tax       = taxRatePct ? Math.round(taxable × rate / 100) : taxP     (taxable = gross − discount)
 *   invoice disc.  = min(invoiceDiscountP, max(0, subtotal − itemDiscounts))  (capped at what is left to discount)
 *   grand total    = subtotal − itemDiscounts − invoiceDiscount + itemTax + freight + loading + other
 *   paymentStatus  = UNPAID when grand <= 0 (legacy), else PAID when paid >= grand, else PARTIAL / UNPAID
 * Inputs are expected to be valid (non-negative integers); validating them is the caller's job (S7 Zod schemas).
 */

export interface InvoiceLineInput {
  /** Quantity in thousandths of a unit (integer). */
  qtyMilli: number;
  /** Unit price, paisa. */
  unitPriceP: number;
  /** Line discount, paisa (capped at the gross). */
  discountP?: number;
  /** Line tax in paisa — used when no rate is given (the shape of a saved line). */
  taxP?: number;
  /** Tax rate in percent of the taxable amount; wins over `taxP` when non-zero (legacy `taxRate`). */
  taxRatePct?: number;
}

export interface InvoiceLineTotals {
  qtyMilli: number;
  unitPriceP: number;
  grossP: number;
  discountP: number;
  taxP: number;
  lineTotalP: number;
}

export interface InvoiceInput {
  lines: readonly InvoiceLineInput[];
  invoiceDiscountP?: number;
  freightP?: number;
  loadingP?: number;
  otherChargesP?: number;
  paidP?: number;
}

export type InvoicePaymentStatus = "UNPAID" | "PARTIAL" | "PAID";

export interface InvoiceTotals {
  lines: InvoiceLineTotals[];
  subtotalP: number;
  itemDiscountsP: number;
  invoiceDiscountP: number;
  /** itemDiscounts + invoiceDiscount (the legacy header's `discountAmount`). */
  discountAmountP: number;
  /** Σ line tax (the legacy header's `taxAmount`). */
  taxP: number;
  freightP: number;
  loadingP: number;
  otherChargesP: number;
  grandTotalP: number;
  paidP: number;
  balanceP: number;
  paymentStatus: InvoicePaymentStatus;
  totalQtyMilli: number;
  lineCount: number;
}

/** A decimal quantity → thousandths with the legacy `Money.qty` rounding: 2.5 → 2500, 0.3004 → 300. */
export function qtyToMilli(qty: number): number {
  const n = Number(qty);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

/** Thousandths → the legacy decimal quantity (exact: a division of an integer by 1000). */
export function milliToQty(qtyMilli: number): number {
  return qtyMilli / 1000;
}

/** `Money.mul`: paisa × a (possibly fractional) quantity, rounded to whole paisa. */
export function grossOf(unitPriceP: number, qtyMilli: number): number {
  return Math.round((unitPriceP || 0) * (qtyMilli / 1000));
}

/** `Calc.line` over paisa inputs. */
export function lineTotals(line: InvoiceLineInput): InvoiceLineTotals {
  const qtyMilli = line.qtyMilli;
  const unitPriceP = line.unitPriceP;
  const grossP = grossOf(unitPriceP, qtyMilli);
  const discountP = Math.min(line.discountP ?? 0, grossP);
  const taxable = grossP - discountP;
  const taxP = line.taxRatePct ? Math.round((taxable * Number(line.taxRatePct)) / 100) : (line.taxP ?? 0);
  return { qtyMilli, unitPriceP, grossP, discountP, taxP, lineTotalP: taxable + taxP };
}

/** `Calc.paymentStatus`. */
export function paymentStatusOf(grandTotalP: number, paidP: number): InvoicePaymentStatus {
  if (grandTotalP <= 0) return "UNPAID";
  if (paidP >= grandTotalP) return "PAID";
  return paidP > 0 ? "PARTIAL" : "UNPAID";
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + (b || 0), 0);

/** `Calc.invoice` over paisa inputs. */
export function invoiceTotals(input: InvoiceInput): InvoiceTotals {
  const lines = input.lines.map(lineTotals);
  const subtotalP = sum(lines.map((l) => l.grossP));
  const itemDiscountsP = sum(lines.map((l) => l.discountP));
  const taxP = sum(lines.map((l) => l.taxP));
  const invoiceDiscountP = Math.min(input.invoiceDiscountP ?? 0, Math.max(0, subtotalP - itemDiscountsP));
  const freightP = input.freightP ?? 0;
  const loadingP = input.loadingP ?? 0;
  const otherChargesP = input.otherChargesP ?? 0;
  const grandTotalP = subtotalP - itemDiscountsP - invoiceDiscountP + taxP + freightP + loadingP + otherChargesP;
  const paidP = input.paidP ?? 0;
  return {
    lines,
    subtotalP,
    itemDiscountsP,
    invoiceDiscountP,
    discountAmountP: itemDiscountsP + invoiceDiscountP,
    taxP,
    freightP,
    loadingP,
    otherChargesP,
    grandTotalP,
    paidP,
    balanceP: grandTotalP - paidP,
    paymentStatus: paymentStatusOf(grandTotalP, paidP),
    totalQtyMilli: sum(lines.map((l) => l.qtyMilli)),
    lineCount: lines.length,
  };
}
