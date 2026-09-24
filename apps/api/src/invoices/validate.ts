import { grossOf, INVOICE_MESSAGES, invoiceTotals, MAX_AMOUNT_P, milliToQty, qtyToMilli, type InvoiceTotals } from "@farooq/shared";
import { pairKey } from "./stock.js";

/**
 * `Validate.invoice` (02-services.js), ported: the legacy messages verbatim, in the legacy order, all collected (not first-fail).
 * Pure — everything that needs the database is preloaded into a `ValidationContext`, so every rule has a plain unit test.
 *
 * Stricter than the legacy (each is a rule in docs/PARITY.md): a negative line discount, invoice discount or charge is
 * refused; a quantity with more than 3 decimals is refused (the legacy rounded it silently); the stock check is per
 * product × warehouse TOTALLED across lines (the legacy checked line by line, so two lines of one product could oversell);
 * on an edit the invoice's own previously deducted bags count as available again.
 */

/** A line as validated: what the client sent, with the product / warehouse it resolves to. */
export interface LineForValidation {
  productId: string;
  /** Effective godown: the line's own, else the invoice's. */
  warehouseId: string;
  quantity: number;
  unitPriceP: number;
  discountP: number;
  taxP: number;
  taxRatePct: number;
}

export interface ProductLabel {
  name: string;
  nameEn: string | null;
  nameUr: string | null;
}

export interface ValidationContext {
  customerExists: boolean;
  warehouseNames: Map<string, string>;
  products: Map<string, ProductLabel>;
  /** Bags available (thousandths) for a product × godown, INCLUDING this invoice's own previously deducted bags. */
  availableMilli(productId: string, warehouseId: string): number;
  allowNegativeStock: boolean;
  /** Drafts skip the stock check and may have a zero rate. */
  isDraft: boolean;
  /** Post / edit only: a migrated invoice has no stock effect at all, so its bags are never checked. */
  skipStock: boolean;
}

export interface HeaderForValidation {
  customerId: string;
  warehouseId: string;
  invoiceDiscountP: number;
  freightP: number;
  loadingP: number;
  otherChargesP: number;
  paidP: number;
}

/** The legacy `p.en || p.ur` label used inside messages. */
export const productLabel = (p: ProductLabel): string => p.nameEn || p.nameUr || p.name;

/** At most 3 decimals: 2.5 and 0.125 pass, 0.3004 does not (float-safe: compares against the nearest thousandth). */
export const hasAtMostThreeDecimals = (q: number): boolean => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-7;

/** Largest quantity accepted on one line: a million bags, in thousandths. Far above any real sale, far below what could overflow a total. */
export const MAX_QTY_MILLI = 1_000_000_000;

export interface ValidationResult {
  errors: string[];
  /** The totals the invoice would have (computed from the lines whether or not they are valid, like the legacy). */
  totals: InvoiceTotals;
}

export function validateInvoice(header: HeaderForValidation, lines: readonly LineForValidation[], ctx: ValidationContext): ValidationResult {
  const errs: string[] = [];
  if (!header.customerId || !ctx.customerExists) errs.push(INVOICE_MESSAGES.chooseShop);
  if (!header.warehouseId || !ctx.warehouseNames.has(header.warehouseId)) errs.push(INVOICE_MESSAGES.chooseWarehouse);
  if (lines.length === 0) errs.push(INVOICE_MESSAGES.noLines);

  const requested = new Map<string, { productId: string; warehouseId: string; milli: number }>();
  lines.forEach((line, i) => {
    const p = ctx.products.get(line.productId);
    const n = `Line ${i + 1}`;
    if (!p) {
      errs.push(`${n}: that product no longer exists.`);
      return;
    }
    const label = `${n} (${productLabel(p)})`;
    const qtyOk = Number.isFinite(line.quantity) && hasAtMostThreeDecimals(line.quantity);
    const milli = qtyToMilli(line.quantity);
    if (!(line.quantity > 0)) errs.push(`${label}: quantity must be more than zero.`);
    else if (!qtyOk) errs.push(`${label}: the quantity can have at most 3 decimal places.`);
    else if (milli > MAX_QTY_MILLI) errs.push(`${label}: that quantity is too large.`);

    if (line.unitPriceP < 0) errs.push(`${n}: the rate cannot be negative.`);
    if (!ctx.isDraft && line.unitPriceP === 0) errs.push(`${label}: enter a rate per bag.`);
    if (line.discountP < 0) errs.push(`${n}: the discount cannot be negative.`);
    if (line.taxP < 0) errs.push(`${n}: the tax cannot be negative.`);
    // (a line with no valid quantity has no amount to compare with: the legacy also printed this message for a negative quantity, which only added noise)
    if (qtyOk && milli > 0 && line.discountP > grossOf(line.unitPriceP, milli)) errs.push(`${n}: the discount is larger than the line amount.`);
    if (grossOf(line.unitPriceP, milli) > MAX_AMOUNT_P) errs.push(`${n}: the line amount is too large.`);
    if (!ctx.warehouseNames.has(line.warehouseId)) errs.push(`${n}: choose the warehouse this line leaves from.`);

    if (qtyOk && milli > 0) {
      const key = pairKey(line);
      const known = requested.get(key);
      if (known) known.milli += milli;
      else requested.set(key, { productId: line.productId, warehouseId: line.warehouseId, milli });
    }
  });

  if (!ctx.isDraft && !ctx.skipStock && !ctx.allowNegativeStock) {
    for (const r of requested.values()) {
      const have = ctx.availableMilli(r.productId, r.warehouseId);
      if (r.milli > have) {
        const p = ctx.products.get(r.productId)!;
        errs.push(`Only ${milliToQty(have)} bags of ${productLabel(p)} are available in ${ctx.warehouseNames.get(r.warehouseId) ?? r.warehouseId}. Requested: ${milliToQty(r.milli)}.`);
      }
    }
  }

  if (header.invoiceDiscountP < 0) errs.push("The invoice discount cannot be negative.");
  if (header.freightP < 0) errs.push("The freight cannot be negative.");
  if (header.loadingP < 0) errs.push("The loading charge cannot be negative.");
  if (header.otherChargesP < 0) errs.push("The other charges cannot be negative.");

  const totals = invoiceTotals({
    lines: lines.map((l) => ({ qtyMilli: qtyToMilli(l.quantity), unitPriceP: l.unitPriceP, discountP: Math.max(0, l.discountP), taxP: Math.max(0, l.taxP), taxRatePct: l.taxRatePct })),
    invoiceDiscountP: Math.max(0, header.invoiceDiscountP),
    freightP: Math.max(0, header.freightP),
    loadingP: Math.max(0, header.loadingP),
    otherChargesP: Math.max(0, header.otherChargesP),
    paidP: header.paidP,
  });
  if (totals.grandTotalP > MAX_AMOUNT_P) errs.push("The invoice total is too large.");
  if (header.paidP < 0) errs.push(INVOICE_MESSAGES.paidNegative);
  if (header.paidP > totals.grandTotalP) errs.push(INVOICE_MESSAGES.overpaid);
  return { errors: [...new Set(errs)], totals };
}
