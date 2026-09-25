import type postgres from "postgres";
import { allocateCharges, costBasisOf, invoiceTotals, unitCostForAverage, weightedAverage, type AverageLine, type CostBasis } from "@farooq/shared";
import type { Backup } from "./validate.js";
import type { PurchaseMismatch, PurchaseStockMismatch, ReconciliationReport } from "./reconcile.js";

/**
 * S11's checks, in the same spirit as S6's (`reconcile-stock.ts`): each compares two things that never call each other.
 *   1. purchase totals   the shared port of the legacy `Calc` (purchases reuse `Calc.invoice`) run over the purchase LINES in the
 *                        database, against the header the purchase carries and every stored line total;
 *   2. purchase <-> stock every purchase's stock movements, per product x warehouse, net to the bags its lines say arrived;
 *   3. average cost      the shared port of the legacy weighted average (`Landed.weightedAverage` / `Cost.weightedAverage`) over the
 *                        purchase lines, against every imported `stock_levels.avg_cost_p` that has a purchase line behind it;
 *      + the substitution S12 relies on: a line's `operational_share_p` equals what the landed-cost rows of the BACKUP say
 *        (`inventoryCostAdjust`, read from the JSON because the store is deferred), and its `landed_unit_cost_p` equals goods unit +
 *        round(charge share / bags) + round(operational share / bags).
 * A mismatch is named (purchase number / product / legacy ids), never just counted. A stock row with no purchase line is LISTED as
 * "kept from before" (the legacy keeps the old average when nothing is left to average) - informational, not a failure.
 */

const num = (v: unknown): number => Number(v);
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

type Client = postgres.Sql;

export type PurchaseChecks = Pick<ReconciliationReport, "purchases" | "purchaseStock" | "averageCost">;

export async function checkPurchases(client: Client, backup: Backup): Promise<PurchaseChecks> {
  const headers = await client`
    SELECT id, purchase_number, legacy_id, status, migrated, total_p::text AS total_p, subtotal_p::text AS subtotal_p,
           discount_amount_p::text AS discount_amount_p, tax_p::text AS tax_p, freight_p::text AS freight_p, loading_p::text AS loading_p,
           other_charges_p::text AS other_charges_p, total_qty_milli::text AS total_qty_milli, line_count
    FROM purchases ORDER BY purchase_number NULLS LAST, legacy_id`;
  const lineRows = await client`
    SELECT i.id, i.legacy_id, i.purchase_id, i.product_id, i.warehouse_id, i.sort_order, p.legacy_id AS product, w.legacy_id AS warehouse,
           i.qty_milli::text AS qty_milli, i.received_qty_milli::text AS received_qty_milli, i.unit_price_p::text AS unit_price_p,
           i.discount_p::text AS discount_p, i.tax_p::text AS tax_p, i.line_total_p::text AS line_total_p,
           i.goods_unit_cost_p::text AS goods_unit_cost_p, i.charge_share_p::text AS charge_share_p,
           i.landed_unit_cost_p::text AS landed_unit_cost_p, i.operational_share_p::text AS operational_share_p
    FROM purchase_items i JOIN products p ON p.id = i.product_id JOIN warehouses w ON w.id = i.warehouse_id
    ORDER BY i.purchase_id, i.sort_order, i.id`;
  const linesOf = new Map<string, postgres.Row[]>();
  for (const l of lineRows) {
    const list = linesOf.get(l.purchase_id as string);
    if (list) list.push(l);
    else linesOf.set(l.purchase_id as string, [l]);
  }
  const nameOf = (h: postgres.Row): string => (h.purchase_number as string | null) ?? `(no number, ${h.legacy_id as string})`;
  const cancelled = (h: postgres.Row) => h.status === "CANCELLED";
  const avgLineOf = (l: postgres.Row): AverageLine => ({
    qtyMilli: num(l.qty_milli), receivedQtyMilli: num(l.received_qty_milli), unitPriceP: num(l.unit_price_p), lineTotalP: num(l.line_total_p),
    goodsUnitCostP: optNum(l.goods_unit_cost_p), chargeShareP: optNum(l.charge_share_p), landedUnitCostP: optNum(l.landed_unit_cost_p),
    operationalShareP: optNum(l.operational_share_p),
  });

  /* ── 1. purchase totals ────────────────────────────────────────────── */
  const purchases: PurchaseChecks["purchases"] = {
    checked: 0, lines: 0, orderedQtyMilli: 0, receivedQtyMilli: 0, totalMismatches: [], noLines: [], cancelled: 0, migrated: [], migratedMismatches: [],
  };
  for (const h of headers) {
    const lines = linesOf.get(h.id as string) ?? [];
    if (h.migrated) purchases.migrated.push(nameOf(h));
    if (cancelled(h)) {
      purchases.cancelled++;
      continue;
    }
    if (lines.length === 0) {
      purchases.noLines.push(nameOf(h));
      continue;
    }
    // The legacy record keeps line discounts + the overall discount as ONE figure (`discountAmount`); the overall part is what is
    // not on a line (`Purchases.toDraft`: max(0, discountAmount - Σ line discounts)), and Calc.invoice caps it like any invoice discount.
    const lineDiscounts = lines.reduce((a, l) => a + num(l.discount_p), 0);
    const overallDiscount = Math.max(0, num(h.discount_amount_p) - lineDiscounts);
    const t = invoiceTotals({
      lines: lines.map((l) => ({ qtyMilli: num(l.qty_milli), unitPriceP: num(l.unit_price_p), discountP: num(l.discount_p), taxP: num(l.tax_p) })),
      invoiceDiscountP: overallDiscount,
      freightP: num(h.freight_p),
      loadingP: num(h.loading_p),
      otherChargesP: num(h.other_charges_p),
    });
    const problems: string[] = [];
    const cmp = (what: string, recomputed: number, stored: number) => {
      if (recomputed !== stored) problems.push(`${what}: lines give ${recomputed}, header says ${stored}`);
    };
    cmp("grand total", t.grandTotalP, num(h.total_p));
    cmp("subtotal", t.subtotalP, num(h.subtotal_p));
    cmp("discount amount", t.discountAmountP, num(h.discount_amount_p));
    cmp("tax", t.taxP, num(h.tax_p));
    cmp("quantity (thousandths)", t.totalQtyMilli, num(h.total_qty_milli));
    cmp("line count", t.lineCount, num(h.line_count));
    lines.forEach((l, i) => cmp(`line ${i + 1} total`, t.lines[i]!.lineTotalP, num(l.line_total_p)));
    if (h.migrated) {
      if (problems.length) purchases.migratedMismatches.push({ purchase: nameOf(h), problems });
    } else if (problems.length) {
      purchases.totalMismatches.push({ purchase: nameOf(h), problems } satisfies PurchaseMismatch);
    }
    purchases.checked++;
    purchases.lines += lines.length;
    purchases.orderedQtyMilli += t.totalQtyMilli;
    purchases.receivedQtyMilli += lines.reduce((a, l) => a + num(l.received_qty_milli), 0);
  }

  /* ── 2. purchase <-> stock ─────────────────────────────────────────── */
  const purchaseStock: PurchaseChecks["purchaseStock"] = { purchasesChecked: 0, migratedSkipped: [], movementsChecked: 0, mismatches: [] };
  const netRows = await client`
    SELECT m.source_id, m.product_id, m.warehouse_id, SUM(m.qty_delta_milli)::text AS net, count(*)::text AS n
    FROM stock_movements m WHERE m.source_type = 'PURCHASE' AND m.bucket = 'stock' GROUP BY m.source_id, m.product_id, m.warehouse_id`;
  const pairKey = (product: string, warehouse: string) => `${product}\u0000${warehouse}`;
  const netOf = new Map<string, Map<string, number>>();
  for (const r of netRows) {
    const m = netOf.get(r.source_id as string) ?? new Map<string, number>();
    m.set(pairKey(r.product_id as string, r.warehouse_id as string), num(r.net));
    netOf.set(r.source_id as string, m);
    purchaseStock.movementsChecked += num(r.n);
  }
  const productName = new Map<string, string>((await client`SELECT id, legacy_id FROM products`).map((r) => [r.id as string, r.legacy_id as string]));
  const warehouseName = new Map<string, string>((await client`SELECT id, legacy_id FROM warehouses`).map((r) => [r.id as string, r.legacy_id as string]));
  for (const h of headers) {
    if (h.migrated) {
      purchaseStock.migratedSkipped.push(nameOf(h));
      continue;
    }
    purchaseStock.purchasesChecked++;
    // What the lines say arrived: the received bags per product x warehouse. A cancelled purchase holds no stock: every bag has come back out.
    const expected = new Map<string, number>();
    if (!cancelled(h)) {
      for (const l of linesOf.get(h.id as string) ?? []) {
        const k = pairKey(l.product_id as string, l.warehouse_id as string);
        expected.set(k, (expected.get(k) ?? 0) + num(l.received_qty_milli));
      }
    }
    const net = netOf.get(h.id as string) ?? new Map<string, number>();
    for (const k of new Set([...expected.keys(), ...net.keys()])) {
      const e = expected.get(k) ?? 0;
      const n = net.get(k) ?? 0;
      if (e !== n) {
        const [p, w] = k.split("\u0000") as [string, string];
        purchaseStock.mismatches.push({ purchase: nameOf(h), product: productName.get(p) ?? p, warehouse: warehouseName.get(w) ?? w, expectedMilli: e, netMilli: n } satisfies PurchaseStockMismatch);
      }
    }
  }

  /* ── 3. average cost ───────────────────────────────────────────────── */
  const settings = await client`SELECT doc->>'profitCostBasis' AS basis FROM company_profile ORDER BY id LIMIT 1`;
  const basis: CostBasis = costBasisOf(settings[0]?.basis);
  const averageCost: PurchaseChecks["averageCost"] = {
    basis,
    rows: 0,
    matched: 0,
    keptFromBefore: [],
    mismatches: [],
    operationalShare: { linesChecked: 0, withShare: 0, orphanRows: [], mismatches: [] },
    landedUnit: { linesChecked: 0, skippedNothingReceived: 0, mismatches: [] },
    allocation: { linesChecked: 0, differs: [] },
  };

  const headerById = new Map<string, postgres.Row>(headers.map((h) => [h.id as string, h]));
  const byLevel = new Map<string, postgres.Row[]>();
  for (const l of lineRows) {
    if (cancelled(headerById.get(l.purchase_id as string)!)) continue;
    const k = pairKey(l.product_id as string, l.warehouse_id as string);
    const list = byLevel.get(k);
    if (list) list.push(l);
    else byLevel.set(k, [l]);
  }
  const levels = await client`SELECT product_id, warehouse_id, avg_cost_p::text AS avg FROM stock_levels WHERE bucket = 'stock' ORDER BY product_id, warehouse_id`;
  for (const lv of levels) {
    const stored = num(lv.avg);
    const lines = (byLevel.get(pairKey(lv.product_id as string, lv.warehouse_id as string)) ?? []).filter((l) => num(l.received_qty_milli) > 0);
    const product = productName.get(lv.product_id as string) ?? (lv.product_id as string);
    const warehouse = warehouseName.get(lv.warehouse_id as string) ?? (lv.warehouse_id as string);
    if (lines.length === 0) {
      averageCost.keptFromBefore.push({ product, warehouse, avgCostP: stored });
      continue;
    }
    averageCost.rows++;
    const recomputed = weightedAverage(lines.map(avgLineOf), basis);
    if (recomputed === stored) averageCost.matched++;
    else averageCost.mismatches.push({ product, warehouse, purchaseLines: lines.length, recomputedP: recomputed, storedP: stored });
  }

  // the operational share: the landed-cost rows of the backup (a deferred store, read here, never loaded) against the line's column
  const landedCostStatus = new Map<string, string>((backup.data.landedCosts ?? []).map((lc) => [String(lc.id), String(lc.status)]));
  const extraOf = new Map<string, number>();
  for (const adj of backup.data.inventoryCostAdjust ?? []) {
    if (landedCostStatus.get(String(adj.landedCostId)) === "CANCELLED") continue; // the legacy `extraForItem`: a cancelled entry adds nothing
    extraOf.set(String(adj.purchaseItemId), (extraOf.get(String(adj.purchaseItemId)) ?? 0) + Number(adj.additionalCost || 0));
  }
  const lineByLegacy = new Map<string, postgres.Row>(lineRows.map((l) => [l.legacy_id as string, l]));
  for (const legacyId of extraOf.keys()) {
    if (!lineByLegacy.has(legacyId)) averageCost.operationalShare.orphanRows.push(legacyId);
  }
  for (const l of lineRows) {
    const h = headerById.get(l.purchase_id as string)!;
    const expected = extraOf.get(l.legacy_id as string) ?? 0;
    const stored = optNum(l.operational_share_p) ?? 0;
    averageCost.operationalShare.linesChecked++;
    if (stored > 0 || expected > 0) averageCost.operationalShare.withShare++;
    if (stored !== expected) {
      averageCost.operationalShare.mismatches.push({ purchase: nameOf(h), line: l.legacy_id as string, storedP: stored, landedCostRowsP: expected });
    }
  }

  // the landed unit: goods unit + round(charge share / bags) + round(operational share / bags), where the line is costed at all
  for (const h of headers) {
    if (cancelled(h) || h.migrated) continue;
    const lines = linesOf.get(h.id as string) ?? [];
    for (const l of lines) {
      const a = avgLineOf(l);
      if (a.landedUnitCostP === null) continue;
      if (a.receivedQtyMilli === 0) {
        averageCost.landedUnit.skippedNothingReceived++;
        continue;
      }
      averageCost.landedUnit.linesChecked++;
      const expected = unitCostForAverage(a, "LANDED");
      if (expected !== a.landedUnitCostP) {
        averageCost.landedUnit.mismatches.push({ purchase: nameOf(h), line: l.legacy_id as string, storedP: a.landedUnitCostP, recomputedP: expected });
      }
    }
    // informational: the stored goods unit / charge share against `allocateCharges` (the fix-3 port). They differ on a part delivery ON PURPOSE.
    if (lines.length && lines.every((l) => optNum(l.goods_unit_cost_p) !== null)) {
      const charges = num(h.freight_p) + num(h.loading_p) + num(h.other_charges_p);
      const alloc = allocateCharges(
        lines.map((l) => ({ qtyMilli: num(l.qty_milli), receivedQtyMilli: num(l.received_qty_milli), unitPriceP: num(l.unit_price_p), lineTotalP: num(l.line_total_p) })),
        charges,
      );
      lines.forEach((l, i) => {
        averageCost.allocation.linesChecked++;
        const a = alloc[i]!;
        const storedGoods = num(l.goods_unit_cost_p);
        const storedShare = optNum(l.charge_share_p) ?? 0;
        if (storedGoods !== a.goodsUnitP || storedShare !== a.chargeShareP) {
          averageCost.allocation.differs.push({ purchase: nameOf(h), line: l.legacy_id as string, storedGoodsUnitP: storedGoods, goodsUnitP: a.goodsUnitP, storedChargeShareP: storedShare, chargeShareP: a.chargeShareP });
        }
      });
    }
  }

  return { purchases, purchaseStock, averageCost };
}
