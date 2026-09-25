import { milliToQty } from "@farooq/shared";
import { rupees } from "../payments/receipt-core.js";

/**
 * What an EDIT of a recorded purchase has to respect — the legacy `Purchases.editErrors` (02-services.js 936-1016), every message
 * verbatim, in the legacy order. Pure: everything that needs the database is loaded first by the service and handed in, so each rule has
 * a plain unit test. (The cancelled check, the stale-revision check and "the amount paid is more than the total" are the service's /
 * `validatePurchase`'s; the legacy printed the last one from here, the wording is the same.)
 */

export interface OldLineFacts {
  id: string;
  productId: string;
  warehouseId: string;
  descriptionSnapshot: string | null;
  descriptionEnSnapshot: string | null;
  /** Bags received before this edit, thousandths. */
  receivedQtyMilli: number;
  /** Bags sent back to the supplier (M5 fills it), thousandths. */
  returnedQtyMilli: number;
  /** Landed-cost money spread over the line (M6 writes it); 0 / null = none standing. */
  operationalShareP: number | null;
}

export interface NewLineFacts {
  /** The id of the old line this one keeps; absent = a new line. */
  id: string | undefined;
  productId: string;
  /** Effective godown: the line's own, else the purchase's. */
  warehouseId: string;
  /** Bags received, thousandths (the legacy blank resolved to the whole quantity). */
  receivedQtyMilli: number;
}

export interface EditFacts {
  oldLines: readonly OldLineFacts[];
  newLines: readonly NewLineFacts[];
  /** Why the supplier may not be swapped, when it is being swapped; null = fine (or not swapped). */
  supplierLockReason: string | null;
  /** Paid against this purchase before the edit (POSTED vouchers) and the receipt numbers of those vouchers. */
  paidNowP: number;
  voucherNumbers: readonly string[];
  /** What the edited purchase says was paid in all. */
  newPaidP: number;
  allowNegativeStock: boolean;
  /** Bags in the godown now (thousandths) — the sellable bucket. */
  levelMilli(productId: string, warehouseId: string): number;
  productName(productId: string): string;
  warehouseName(warehouseId: string): string;
}

export const pairOf = (productId: string, warehouseId: string): string => `${productId}:${warehouseId}`;

const bags = (milli: number): string => String(milliToQty(milli));

export function editRefusals(f: EditFacts): string[] {
  const errs: string[] = [];
  const kept = new Map<string, NewLineFacts>();
  for (const l of f.newLines) if (l.id && f.oldLines.some((o) => o.id === l.id)) kept.set(l.id, l);

  // a line that has bags sent back to the supplier, or operational costs spread over it, is tied to that record: it can change in
  // quantity and rate, but it cannot vanish or turn into a different product
  for (const o of f.oldLines) {
    const name = o.descriptionEnSnapshot || o.descriptionSnapshot || "a line";
    const ret = o.returnedQtyMilli;
    const landed = (o.operationalShareP ?? 0) !== 0;
    if (!ret && !landed) continue;
    const why = ret ? `${bags(ret)} bag${ret === 1000 ? " has" : "s have"} been returned to the supplier` : "landed costs have been spread over it";
    const l = kept.get(o.id);
    if (!l) {
      errs.push(`${name}: ${why}, so this line cannot be removed. ${ret ? "It can be reduced, but not below the bags already returned." : "Cancel the landed-cost entry first."}`);
      continue;
    }
    if (l.productId !== o.productId || l.warehouseId !== o.warehouseId) errs.push(`${name}: ${why}, so its product and warehouse cannot be changed.`);
    if (ret && l.receivedQtyMilli < ret) errs.push(`${name}: ${bags(ret)} bags were already returned to the supplier, so fewer than ${bags(ret)} cannot be shown as received.`);
  }

  if (f.supplierLockReason) errs.push(f.supplierLockReason);

  if (f.newPaidP < f.paidNowP) {
    errs.push(
      `${rupees(f.paidNowP)} has already been paid against this purchase (${f.voucherNumbers.join(", ")}). ` +
        "The amount paid cannot be lowered here — reverse that payment voucher from Payments instead.",
    );
  }

  // Stock is judged on what the edit CHANGES per product and warehouse: the old delivery comes out, the new one goes in, and the
  // difference must fit in what is on the shelf now. An untouched line therefore never fails just because its bags have since been sold.
  if (!f.allowNegativeStock) {
    for (const d of netStockChange(f.oldLines, f.newLines)) {
      if (d.milli >= 0) continue;
      const have = f.levelMilli(d.productId, d.warehouseId);
      if (have + d.milli < 0) {
        errs.push(
          `Only ${bags(have)} bags of ${f.productName(d.productId)} are in ${f.warehouseName(d.warehouseId)} now, but this edit takes ${bags(-d.milli)} fewer bags into stock than before. ` +
            "The rest of that delivery has already been sold or moved, so it cannot be reduced by that much.",
        );
      }
    }
  }
  return [...new Set(errs)];
}

export interface PairChange {
  productId: string;
  warehouseId: string;
  milli: number;
}

/** New received bags minus old received bags, per product × warehouse, in the fixed order every transaction locks in. Zero changes included. */
export function netStockChange(oldLines: readonly Pick<OldLineFacts, "productId" | "warehouseId" | "receivedQtyMilli">[], newLines: readonly Pick<NewLineFacts, "productId" | "warehouseId" | "receivedQtyMilli">[]): PairChange[] {
  const net = new Map<string, PairChange>();
  const bump = (productId: string, warehouseId: string, milli: number) => {
    const k = pairOf(productId, warehouseId);
    const known = net.get(k);
    if (known) known.milli += milli;
    else net.set(k, { productId, warehouseId, milli });
  };
  for (const o of oldLines) bump(o.productId, o.warehouseId, -o.receivedQtyMilli);
  for (const n of newLines) bump(n.productId, n.warehouseId, n.receivedQtyMilli);
  return [...net.values()].sort((a, b) => (a.productId === b.productId ? (a.warehouseId < b.warehouseId ? -1 : a.warehouseId > b.warehouseId ? 1 : 0) : a.productId < b.productId ? -1 : 1));
}

/** Wording for a supplier swap that is refused because money was paid against the purchase (legacy `supplierLockReason`). */
export const supplierLockedByPayments = (receipts: readonly string[]): string =>
  `Money has already been paid against this purchase (${receipts.join(", ")}), and it belongs to this supplier — so the supplier cannot be changed here. Reverse that payment voucher first.`;

/** …and because a return to the supplier was posted against it. */
export const supplierLockedByReturns = (numbers: readonly string[]): string =>
  `A return to the supplier has been posted against this purchase (${numbers.join(", ")}), so the supplier cannot be changed.`;
