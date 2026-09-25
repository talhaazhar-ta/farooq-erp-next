/**
 * Purchase costing — a port of the legacy `Cost.allocate` and of the two weighted averages
 * (`Cost.weightedAverage` in `17-profit.js` for the PURCHASE basis, `Landed.weightedAverage` in `26-landed-cost.js` for
 * the LANDED basis, which is what the real data uses). S11 ports and PROVES them (the importer's reconciliation recomputes
 * every stored average cost from the purchase lines); S12 is the first code that writes them.
 *
 * Money is integer paisa; quantities are integer thousandths (`qtyMilli`, like `invoice-totals.ts`). Divisions are written
 * the way the legacy wrote them (`Math.round(paisa / bags)`), so the rounding is the old app's rounding.
 *
 * The one place this differs from the legacy is deliberate (owner decision 2026-09-25, "fix 3"): on a PART DELIVERY the
 * legacy `allocate` divided the line's value by the RECEIVED bags (`basis = received || qty`), so 100 bags ordered at
 * Rs 1,000 a bag with 60 delivered "cost" Rs 1,667 a bag - the unit cost was overstated by ordered / received, and it
 * became the moving average. The bill is for what was ORDERED, so the goods unit here is the line value divided by the
 * ORDERED bags. The charges (freight, loading, ...) are still spread per RECEIVED bag - they are paid to move the bags that
 * arrived. With a full delivery both readings are the same number, and no real purchase has a part delivery, so the fix
 * changes no real figure (the reconciliation proves that on every real backup).
 */

export type CostBasis = "LANDED" | "PURCHASE";

/** The legacy default when the settings do not say (`17-profit.js` `Cost.basis`). */
export const DEFAULT_COST_BASIS: CostBasis = "LANDED";

/** Reads the `profitCostBasis` setting; anything other than `PURCHASE` is the default, LANDED (the legacy `|| 'LANDED'`). */
export function costBasisOf(setting: unknown): CostBasis {
  return setting === "PURCHASE" ? "PURCHASE" : DEFAULT_COST_BASIS;
}

export interface AllocLine {
  /** Ordered bags, thousandths (> 0). */
  qtyMilli: number;
  /** Bags that arrived, thousandths. The caller resolves the legacy "absent = the whole line" before calling. */
  receivedQtyMilli: number;
  /** Per bag, paisa. Used only when a line has no bags at all (`basis` 0). */
  unitPriceP: number;
  /** The line's value: gross - discount + tax. */
  lineTotalP: number;
}

export interface AllocatedLine {
  /** What one bag costs before the charges: line value / ORDERED bags (fix 3). */
  goodsUnitP: number;
  /** This line's share of the charges, paisa, in proportion to its value. */
  chargeShareP: number;
  /** goods unit + the share per received bag. */
  landedUnitP: number;
  /** The bags the share is spread over: received, else ordered (the legacy `basis`). */
  basisMilli: number;
}

/**
 * `Cost.allocate`: spreads `chargesP` (freight + loading + other) over the lines in proportion to their value.
 * A purchase with no value (all lines free) spreads the charges evenly. Negative charges count as none.
 */
export function allocateCharges(lines: readonly AllocLine[], chargesP: number): AllocatedLine[] {
  const goods = lines.reduce((a, l) => a + Math.max(0, l.lineTotalP), 0);
  const extra = Math.max(0, chargesP || 0);
  return lines.map((l) => {
    const orderedMilli = l.qtyMilli;
    const basisMilli = l.receivedQtyMilli || orderedMilli;
    // Fix 3: legacy `basis ? Math.round(lineTotal / basis) : unitPrice` with basis = received || qty.
    const goodsUnitP = orderedMilli ? Math.round(l.lineTotalP / (orderedMilli / 1000)) : l.unitPriceP;
    const chargeShareP = goods > 0 ? Math.round((extra * l.lineTotalP) / goods) : lines.length ? Math.round(extra / lines.length) : 0;
    const landedUnitP = basisMilli ? goodsUnitP + Math.round(chargeShareP / (basisMilli / 1000)) : goodsUnitP;
    return { goodsUnitP, chargeShareP, landedUnitP, basisMilli };
  });
}

/** A stored purchase line, as the averages read it. A null cost column = "never computed" (the legacy `undefined`). */
export interface AverageLine {
  qtyMilli: number;
  receivedQtyMilli: number;
  unitPriceP: number;
  lineTotalP: number;
  goodsUnitCostP: number | null;
  chargeShareP: number | null;
  landedUnitCostP: number | null;
  operationalShareP: number | null;
}

/** The goods unit the averages fall back on when the line has no stored one: `it.goodsUnitCost || (quantity ? round(lineTotal / quantity) : unitPrice)`. */
function goodsUnitOf(l: AverageLine): number {
  return l.goodsUnitCostP || (l.qtyMilli ? Math.round(l.lineTotalP / (l.qtyMilli / 1000)) : l.unitPriceP);
}

/**
 * The per-bag figure one line contributes to the weighted average.
 *   PURCHASE   `Cost.weightedAverage`: the goods unit (the stored `goodsUnitCost`, else derived).
 *   LANDED     `Landed.weightedAverage`: goods unit + round(chargeShare / q) + round(operationalShare / q), q = received bags.
 * The LANDED figure is rebuilt from its parts on purpose (never read from `landedUnitCost`): re-running it is always safe,
 * and reconciliation separately proves `landedUnitCost` equals the same sum. Returns 0 when nothing was received (q = 0).
 */
export function unitCostForAverage(l: AverageLine, basis: CostBasis): number {
  const goods = goodsUnitOf(l);
  if (basis === "PURCHASE") return goods;
  const q = l.receivedQtyMilli / 1000;
  if (!q) return 0;
  return goods + Math.round((l.chargeShareP || 0) / q) + Math.round((l.operationalShareP || 0) / q);
}

/**
 * The weighted average cost of the lines given (they must be every non-cancelled purchase line of ONE product x warehouse):
 * Σ unit x received / Σ received, rounded. Lines that received nothing do not count. Returns `null` when no bag was
 * received at all - the legacy answered 0 there and its CALLERS decided what that meant: a dropped product KEEPS its old
 * average (`if (!avg) return`), a saved line falls back to its own unit. Callers must keep that rule; this function does
 * not invent a cost.
 */
export function weightedAverage(lines: readonly AverageLine[], basis: CostBasis): number | null {
  let qtyMilli = 0;
  let valueMilli = 0;
  for (const l of lines) {
    if (!l.receivedQtyMilli) continue;
    qtyMilli += l.receivedQtyMilli;
    valueMilli += unitCostForAverage(l, basis) * l.receivedQtyMilli;
  }
  return qtyMilli ? Math.round(valueMilli / qtyMilli) : null;
}
