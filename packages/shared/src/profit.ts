/**
 * Profit on one sales invoice (S8). The legacy has two answers and they disagree (17-profit.js):
 *
 *   `Profit.line`     revenue = the line total (after the line discount), cost = round(cost snapshot × qty)
 *   `Profit.invoice`  profit  = GRAND TOTAL − Σ line costs  — so freight, loading and other charges and the tax the shop pays
 *                     count as profit (they are not margin on goods) and an unknown cost (0) counts as free stock
 *   `Profit.report`   sums line revenue only, so a report and an invoice never agreed
 *
 * ADOPTED (planner decision 3, S8): **goods margin net of the discount actually given**:
 *
 *   line revenue   = line total − line tax          (gross − line discount)
 *   line cost      = round(cost snapshot × qty)      (`Money.mul`, as the legacy)
 *   invoice profit = Σ (line revenue − line cost) − invoice discount
 *
 * Charges and tax are not margin and are excluded. A line whose cost is unknown (`cost_snapshot_p` null or 0) is flagged
 * `costKnown: false` and shown WITHOUT a profit (never as if it cost nothing); it stays out of the margin percentage, and
 * the invoice discount is shared over the known lines in proportion to their revenue (all of it when every cost is known).
 * `complete` says whether every line had a cost. The legacy figure is returned as `legacyProfitP` only so a test can hold
 * the two definitions side by side; the API never sends it.
 *
 * Money is integer paisa. Percentages are rounded to two decimals.
 */

export interface ProfitLineInput {
  /** Quantity in thousandths of a bag. */
  qtyMilli: number;
  /** The line total as stored: gross − line discount + line tax. */
  lineTotalP: number;
  taxP: number;
  /** What one bag cost when this was sold; null / 0 = never known. */
  costSnapshotP: number | null;
}

export interface ProfitLine {
  revenueP: number;
  costKnown: boolean;
  /** Round(cost × qty); null when the cost is unknown. */
  costP: number | null;
  /** revenue − cost; null when the cost is unknown. */
  profitP: number | null;
  /** Of the sale; null when the cost is unknown or nothing was charged. */
  marginPct: number | null;
  /** On the cost; null when the cost is unknown. */
  markupPct: number | null;
}

export interface InvoiceProfit {
  lines: ProfitLine[];
  /** Σ line revenue over every line. */
  revenueP: number;
  invoiceDiscountP: number;
  /** Σ cost of the lines whose cost is known. */
  costP: number;
  /** The adopted figure; null when no line has a known cost. */
  profitP: number | null;
  /** Of the known lines' revenue after their share of the invoice discount; null when it cannot be said. */
  marginPct: number | null;
  /** True when every line had a known cost — `profitP` is then the whole invoice's. */
  complete: boolean;
  unknownCostLines: number;
  /** The legacy `Profit.invoice`: grand total − Σ cost (unknown = 0). For tests only — not part of any response. */
  legacyProfitP: number;
}

const pct = (x: number): number => Math.round(x * 100) / 100;

/** `Money.mul(cost, qty)`: the float multiply the legacy used, rounded to a whole paisa. */
const costOfLine = (costSnapshotP: number, qtyMilli: number): number => Math.round(costSnapshotP * (qtyMilli / 1000));

export function profitOfLine(l: ProfitLineInput): ProfitLine {
  const revenueP = l.lineTotalP - l.taxP;
  const costKnown = l.costSnapshotP !== null && l.costSnapshotP > 0;
  if (!costKnown) return { revenueP, costKnown, costP: null, profitP: null, marginPct: null, markupPct: null };
  const costP = costOfLine(l.costSnapshotP!, l.qtyMilli);
  const profitP = revenueP - costP;
  return {
    revenueP,
    costKnown,
    costP,
    profitP,
    marginPct: revenueP > 0 ? pct((profitP / revenueP) * 100) : null,
    markupPct: costP > 0 ? pct((profitP / costP) * 100) : null,
  };
}

export function profitOfInvoice(input: { lines: readonly ProfitLineInput[]; invoiceDiscountP: number; grandTotalP: number }): InvoiceProfit {
  const lines = input.lines.map(profitOfLine);
  const revenueP = lines.reduce((a, l) => a + l.revenueP, 0);
  const known = lines.filter((l) => l.costKnown);
  const knownRevenueP = known.reduce((a, l) => a + l.revenueP, 0);
  const costP = known.reduce((a, l) => a + l.costP!, 0);
  const complete = known.length === lines.length;
  const discountShareP = complete ? input.invoiceDiscountP : revenueP > 0 ? Math.round((input.invoiceDiscountP * knownRevenueP) / revenueP) : 0;
  const profitP = known.length ? knownRevenueP - costP - discountShareP : null;
  const base = knownRevenueP - discountShareP;
  const legacyCost = input.lines.reduce((a, l) => a + costOfLine(l.costSnapshotP ?? 0, l.qtyMilli), 0);
  return {
    lines,
    revenueP,
    invoiceDiscountP: input.invoiceDiscountP,
    costP,
    profitP,
    marginPct: profitP !== null && base > 0 ? pct((profitP / base) * 100) : null,
    complete,
    unknownCostLines: lines.length - known.length,
    legacyProfitP: input.grandTotalP - legacyCost,
  };
}
