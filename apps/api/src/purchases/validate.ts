import { grossOf, invoiceTotals, MAX_AMOUNT_P, PURCHASE_MESSAGES, qtyToMilli, type InvoiceTotals } from "@farooq/shared";
import { hasAtMostThreeDecimals, MAX_QTY_MILLI, productLabel, type ProductLabel } from "../invoices/validate.js";

/**
 * `Validate.purchase` (02-services.js 326-337), ported: the legacy messages verbatim, in the legacy order, all collected. Pure —
 * everything that needs the database is preloaded into a `PurchaseValidationContext`, so every rule has a plain unit test.
 *
 * Stricter than the legacy (each is a rule in docs/PARITY.md, owner decisions 2026-09-25): an amount paid below 0 or above the
 * total is refused on a NEW purchase too (the legacy checked only an edit); a line discount above the line amount is refused;
 * a negative discount / charge / tax is refused; a quantity with more than 3 decimals is refused (the legacy rounded silently).
 */

export interface PurchaseLineForValidation {
  productId: string;
  /** Effective godown: the line's own, else the purchase's. */
  warehouseId: string;
  quantity: number;
  /** Bags that arrived; undefined = the whole line (the legacy blank). */
  receivedQuantity: number | undefined;
  unitPriceP: number;
  discountP: number;
  taxP: number;
  taxRatePct: number;
}

export interface PurchaseValidationContext {
  supplierExists: boolean;
  warehouseNames: Map<string, string>;
  products: Map<string, ProductLabel>;
}

export interface PurchaseHeaderForValidation {
  supplierId: string;
  warehouseId: string;
  invoiceDiscountP: number;
  freightP: number;
  loadingP: number;
  otherChargesP: number;
  paidP: number;
}

export interface PurchaseValidationResult {
  errors: string[];
  /** The totals the purchase would have (computed from the lines whether or not they are valid, like the legacy). */
  totals: InvoiceTotals;
}

export function validatePurchase(header: PurchaseHeaderForValidation, lines: readonly PurchaseLineForValidation[], ctx: PurchaseValidationContext): PurchaseValidationResult {
  const errs: string[] = [];
  if (!header.supplierId || !ctx.supplierExists) errs.push(PURCHASE_MESSAGES.chooseSupplier);
  if (!header.warehouseId || !ctx.warehouseNames.has(header.warehouseId)) errs.push(PURCHASE_MESSAGES.chooseWarehouse);
  if (lines.length === 0) errs.push(PURCHASE_MESSAGES.noLines);

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
    if (!(line.quantity > 0)) errs.push(`${n}: quantity must be more than zero.`);
    else if (!qtyOk) errs.push(`${label}: the quantity can have at most 3 decimal places.`);
    else if (milli > MAX_QTY_MILLI) errs.push(`${label}: that quantity is too large.`);

    if (line.receivedQuantity !== undefined) {
      if (line.receivedQuantity < 0) errs.push(`${n}: the bags received cannot be negative.`);
      else if (!hasAtMostThreeDecimals(line.receivedQuantity)) errs.push(`${label}: the bags received can have at most 3 decimal places.`);
      else if (qtyToMilli(line.receivedQuantity) > MAX_QTY_MILLI) errs.push(`${label}: the bags received are too many.`);
    }

    if (line.unitPriceP < 0) errs.push(`${n}: invalid rate.`);
    if (line.discountP < 0) errs.push(`${n}: the discount cannot be negative.`);
    if (line.taxP < 0) errs.push(`${n}: the tax cannot be negative.`);
    // (a line with no valid quantity or rate has no amount to compare with; the message would only add noise)
    if (qtyOk && milli > 0 && line.unitPriceP >= 0 && line.discountP > grossOf(line.unitPriceP, milli)) errs.push(`${n}: the discount is larger than the line amount.`);
    if (grossOf(line.unitPriceP, milli) > MAX_AMOUNT_P) errs.push(`${n}: the line amount is too large.`);
    if (!ctx.warehouseNames.has(line.warehouseId)) errs.push(`${n}: choose the warehouse this line goes to.`);
  });

  if (header.invoiceDiscountP < 0) errs.push("The discount cannot be negative.");
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
  if (totals.grandTotalP > MAX_AMOUNT_P) errs.push("The purchase total is too large.");
  if (header.paidP < 0) errs.push(PURCHASE_MESSAGES.paidNegative);
  if (header.paidP > totals.grandTotalP) errs.push(PURCHASE_MESSAGES.overpaid);
  return { errors: [...new Set(errs)], totals };
}
