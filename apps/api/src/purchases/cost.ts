import { and, asc, eq, ne } from "drizzle-orm";
import { purchaseItems, purchases, stockLevels, type Tx } from "@farooq/db";
import { weightedAverage, type AverageLine, type CostBasis } from "@farooq/shared";
import { pairKey, sortedPairs, type StockPair } from "../invoices/stock.js";

/**
 * Average cost after a purchase save (S12; the legacy `17-profit.js` wrapper over `Purchases.save`, planner decision 3 in docs/sessions/S12.md).
 *
 * For every product × godown the save touches now or touched before it (a dropped line, a moved godown), the sellable row's average is
 * RECOMPUTED from every non-cancelled purchase line of that pair — never nudged from the previous figure (a later typed receipt cost must not
 * override a purchase-kept average, `test-stock-value.mjs` M5):
 *   a number   -> `avg_cost_p` = it; a pair this save still has a line in also gets `last_cost_p` = that line's unit on the basis
 *   nothing was ever received for the pair AND this save has a line in it -> the legacy fall-back: `avg_cost_p` = `last_cost_p` = the line's
 *                 unit on the basis (10 of the 16 real stock rows got their bags through warehouse receipts, and the office enters the bill
 *                 with Received = 0: that is how those bags get the bill's price as their cost)
 *   nothing was ever received for the pair and the pair was only DROPPED by this save -> left alone (legacy: "if nothing is left, the old
 *                 average is kept")
 * Never touches a row this save does not touch, and never the `damaged` bucket. The `costHistory` rows the legacy also wrote are not ported.
 */

export interface SavedLineUnit {
  productId: string;
  warehouseId: string;
  /** The unit this line contributes on the basis in force: the goods unit (PURCHASE) or goods + charge share + operational share per bag (LANDED). */
  unitP: number;
}

export async function recomputeAverages(tx: Tx, basis: CostBasis, touched: readonly StockPair[], saved: readonly SavedLineUnit[]): Promise<void> {
  // the last saved line of a pair (by sort order — the caller passes them in that order), as the legacy loop does
  const lastLine = new Map<string, SavedLineUnit>();
  for (const s of saved) lastLine.set(pairKey(s), s);

  for (const pair of sortedPairs(touched)) {
    const rows = await tx
      .select({
        qtyMilli: purchaseItems.qtyMilli,
        receivedQtyMilli: purchaseItems.receivedQtyMilli,
        unitPriceP: purchaseItems.unitPriceP,
        lineTotalP: purchaseItems.lineTotalP,
        goodsUnitCostP: purchaseItems.goodsUnitCostP,
        chargeShareP: purchaseItems.chargeShareP,
        landedUnitCostP: purchaseItems.landedUnitCostP,
        operationalShareP: purchaseItems.operationalShareP,
      })
      .from(purchaseItems)
      .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
      .where(and(eq(purchaseItems.productId, pair.productId), eq(purchaseItems.warehouseId, pair.warehouseId), ne(purchases.status, "CANCELLED")))
      .orderBy(asc(purchaseItems.id));
    const avg = weightedAverage(rows as AverageLine[], basis);
    const own = lastLine.get(pairKey(pair));

    let set: { avgCostP: number; lastCostP?: number } | null = null;
    if (avg !== null) set = own ? { avgCostP: avg, lastCostP: own.unitP } : { avgCostP: avg };
    else if (own) set = { avgCostP: own.unitP, lastCostP: own.unitP };
    if (!set) continue;

    await tx
      .update(stockLevels)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(stockLevels.productId, pair.productId), eq(stockLevels.warehouseId, pair.warehouseId), eq(stockLevels.bucket, "stock")));
  }
}
