import type { CostBasis } from "./purchase-cost.js";

/**
 * What one bag of a SALE is costed at (S14, old repo `c78659b`, 02-services.js `Inventory.extraOf` / `saleCostOf`).
 *
 * The product's "Extra cost per bag" (Prices panel: transport, labour, loading WE pay to bring a bag in) is part of what a sale
 * costs, not of what the bags on the shelf are worth: it feeds the invoice line's cost snapshot and the builder's price hint,
 * never `avg_cost_p`, the purchase average, `last_cost_p` or stock value.
 *
 *   extraOf      0 under the "purchase price only" basis (`PURCHASE`); otherwise `products.extra_p` when > 0, else 0.
 *                (The legacy's rupee `extra` fallback is resolved into `extra_p` by the importer — `productPrices` in packages/import.)
 *   saleCostOf   stock cost + extra, but ONLY when the stock cost is known (> 0): the extra alone is not a cost price and would
 *                show a made-up profit, so an unknown stock cost stays unknown (0).
 */
export function extraOf(extraP: number | null | undefined, basis: CostBasis): number {
  if (basis === "PURCHASE") return 0;
  return extraP !== null && extraP !== undefined && extraP > 0 ? extraP : 0;
}

export interface SaleCost {
  /** stock cost + extra; 0 when the stock cost is unknown. */
  costP: number;
  /** `costOf` — the stock cost alone. */
  stockCostP: number;
  /** The extra actually added (0 when the stock cost is unknown or under `PURCHASE`). */
  extraP: number;
}

export function saleCostOf(stockCostP: number, extraP: number | null | undefined, basis: CostBasis): SaleCost {
  if (!(stockCostP > 0)) return { costP: 0, stockCostP: 0, extraP: 0 };
  const extra = extraOf(extraP, basis);
  return { costP: stockCostP + extra, stockCostP, extraP: extra };
}
