import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { companyProfile, products, readProfitCostBasis, stockLevels, stockMovements, type Executor, type Tx } from "@farooq/db";
import { saleCostOf as saleCostFrom, type SaleCost } from "@farooq/shared";

/**
 * Stock for the invoice service (S7). `stock_movements` is the record (append-only), `stock_levels` the current figure;
 * every movement is written together with its level change in the CALLER'S transaction, and reconciliation proves
 * level = Σ movements. Quantities are integer thousandths (`qtyMilli`); a level may go negative (the legacy allows it when
 * the company setting says so).
 */

export interface StockPair {
  productId: string;
  warehouseId: string;
}

export const pairKey = (p: StockPair): string => `${p.productId}:${p.warehouseId}`;

/** Distinct pairs, in the fixed order every transaction locks them in (product id, then warehouse id): two saves can't deadlock. */
export function sortedPairs(pairs: readonly StockPair[]): StockPair[] {
  const byKey = new Map(pairs.map((p) => [pairKey(p), p]));
  return [...byKey.values()].sort((a, b) => (a.productId === b.productId ? (a.warehouseId < b.warehouseId ? -1 : a.warehouseId > b.warehouseId ? 1 : 0) : a.productId < b.productId ? -1 : 1));
}

/**
 * Locks the sellable-bucket level rows of the given pairs (`FOR UPDATE`, fixed order) and returns each quantity. A pair
 * with no row yet gets a zero row first (the legacy `Inventory.row` does the same), so there is always something to lock —
 * two saves racing for the last bags of a product serialise here and the second sees the first's figure.
 */
export async function lockStockLevels(tx: Tx, pairs: readonly StockPair[]): Promise<Map<string, number>> {
  const ordered = sortedPairs(pairs);
  const out = new Map<string, number>();
  if (ordered.length === 0) return out;
  await tx
    .insert(stockLevels)
    .values(ordered.map((p) => ({ productId: p.productId, warehouseId: p.warehouseId, bucket: "stock", qtyMilli: 0 })))
    .onConflictDoNothing();
  const rows = await tx
    .select({ productId: stockLevels.productId, warehouseId: stockLevels.warehouseId, qtyMilli: stockLevels.qtyMilli })
    .from(stockLevels)
    .where(
      and(
        eq(stockLevels.bucket, "stock"),
        inArray(stockLevels.productId, [...new Set(ordered.map((p) => p.productId))]),
        inArray(stockLevels.warehouseId, [...new Set(ordered.map((p) => p.warehouseId))]),
      ),
    )
    .orderBy(asc(stockLevels.productId), asc(stockLevels.warehouseId))
    .for("update");
  for (const r of rows) out.set(pairKey(r), r.qtyMilli);
  return out;
}

export interface MovementInput {
  date: string;
  productId: string;
  warehouseId: string;
  kind: "SALE_OUT" | "SALE_REVERSAL_IN";
  /** Signed: negative takes bags out of the godown. */
  qtyDeltaMilli: number;
  ref: string | null;
  refType: "INVOICE" | "INVOICE_EDIT" | "INVOICE_CANCEL";
  invoiceId: string;
  note: string | null;
  createdBy: string;
}

/** Any document's movement (S12 generalised `applyMovement` for purchases): bucket `stock`, the level moves by the same amount. */
export interface StockMovementInput {
  date: string;
  productId: string;
  warehouseId: string;
  kind: string;
  /** Signed: negative takes bags out of the godown. */
  qtyDeltaMilli: number;
  /** Cost per bag when known (a purchase's IN); null = no cost recorded, as the legacy wrote a sale. */
  unitCostP: number | null;
  ref: string | null;
  refType: string;
  sourceType: "INVOICE" | "PURCHASE";
  sourceId: string;
  note: string | null;
  createdBy: string;
}

export async function applyStockMovement(tx: Tx, m: StockMovementInput): Promise<void> {
  await tx.insert(stockMovements).values({
    date: m.date,
    productId: m.productId,
    warehouseId: m.warehouseId,
    kind: m.kind,
    bucket: "stock",
    qtyDeltaMilli: m.qtyDeltaMilli,
    unitCostP: m.unitCostP,
    ref: m.ref,
    refType: m.refType,
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    note: m.note,
    createdBy: m.createdBy,
  });
  await tx
    .update(stockLevels)
    .set({ qtyMilli: sql`${stockLevels.qtyMilli} + ${m.qtyDeltaMilli}`, updatedAt: sql`now()` })
    .where(and(eq(stockLevels.productId, m.productId), eq(stockLevels.warehouseId, m.warehouseId), eq(stockLevels.bucket, "stock")));
}

/** Appends one invoice movement (bucket `stock`, no cost, as the legacy wrote a sale) and moves the level by the same amount. */
export async function applyMovement(tx: Tx, m: MovementInput): Promise<void> {
  await applyStockMovement(tx, {
    date: m.date,
    productId: m.productId,
    warehouseId: m.warehouseId,
    kind: m.kind,
    qtyDeltaMilli: m.qtyDeltaMilli,
    unitCostP: null,
    ref: m.ref,
    refType: m.refType,
    sourceType: "INVOICE",
    sourceId: m.invoiceId,
    note: m.note,
    createdBy: m.createdBy,
  });
}

/** The kinds of movement the legacy `carriedCost` counts: stock that came in without ever touching `avgCostP`. */
const CARRIED_KINDS = ["OPENING_STOCK", "ADJUSTMENT_IN", "TRANSFER_IN", "CONVERT_IN"];

/**
 * The weighted cost of stock that came in without moving the average (legacy `Inventory.carriedCost`, scoped to one
 * warehouse), as changed by old repo `b2b0778` (S14): sellable-bucket movements that recorded a cost (> 0; the importer stores a
 * legacy 0 as NULL, exactly the legacy `!(unitCostP > 0)` test) —
 *   - positive movements of the carried kinds count qty x cost;
 *   - a `RECEIPT_EDIT_OUT` (an edited Add-stock receipt taking its old line back out at the OLD cost, qty < 0) SUBTRACTS its qty x cost,
 *     so a corrected cost replaces the old one instead of being averaged with it;
 * and the result is `round(cost / qty)` only when BOTH the net qty and the net cost are > 0, else 0.
 */
export async function carriedCost(db: Executor, productId: string, warehouseId: string): Promise<number> {
  const [row] = await db
    .select({
      qty: sql<string>`COALESCE(SUM(${stockMovements.qtyDeltaMilli}), 0)::text`,
      cost: sql<string>`COALESCE(SUM(${stockMovements.qtyDeltaMilli}::numeric * ${stockMovements.unitCostP}), 0)::text`,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.productId, productId),
        eq(stockMovements.warehouseId, warehouseId),
        eq(stockMovements.bucket, "stock"),
        sql`${stockMovements.unitCostP} > 0`,
        or(
          and(inArray(stockMovements.kind, CARRIED_KINDS), sql`${stockMovements.qtyDeltaMilli} > 0`),
          and(eq(stockMovements.kind, "RECEIPT_EDIT_OUT"), sql`${stockMovements.qtyDeltaMilli} < 0`),
        ),
      ),
    );
  const qty = Number(row?.qty ?? 0);
  const cost = Number(row?.cost ?? 0);
  return qty > 0 && cost > 0 ? Math.round(cost / qty) : 0;
}

/**
 * What one bag of this product costs in this warehouse — the legacy `Inventory.costOf(pid, wid)`, read-only, first hit wins:
 *   1. this row's recorded average cost (`stock_levels.avg_cost_p`);
 *   2. this warehouse's own carried cost (opening stock / adjustments / transfers / conversions that recorded one);
 *   3. any other warehouse's recorded average (the legacy took the first in its own iteration order; here the lowest warehouse id, so it is deterministic);
 *   4. the product's list buy price (`products.buy_p`);
 *   0 when nothing is known. (The legacy's product-wide carried-cost step only applies when no warehouse is given; a line always has one.)
 */
export async function costOf(db: Executor, productId: string, warehouseId: string): Promise<number> {
  const [own] = await db
    .select({ avg: stockLevels.avgCostP })
    .from(stockLevels)
    .where(and(eq(stockLevels.productId, productId), eq(stockLevels.warehouseId, warehouseId), eq(stockLevels.bucket, "stock")));
  if (own && own.avg > 0) return own.avg;

  const carried = await carriedCost(db, productId, warehouseId);
  if (carried) return carried;

  const [other] = await db
    .select({ avg: stockLevels.avgCostP })
    .from(stockLevels)
    .where(and(eq(stockLevels.productId, productId), eq(stockLevels.bucket, "stock"), sql`${stockLevels.avgCostP} > 0`))
    .orderBy(asc(stockLevels.warehouseId))
    .limit(1);
  if (other) return other.avg;

  const [p] = await db.select({ buyP: products.buyP }).from(products).where(eq(products.id, productId));
  return p?.buyP && p.buyP > 0 ? p.buyP : 0;
}

/**
 * What one bag of a SALE is costed at (S14, old repo `c78659b`, `Inventory.saleCostOf`): `costOf` + the product's extra cost per
 * bag (`products.extra_p`; not under the `PURCHASE` basis; only while the stock cost is known). Feeds the invoice line's cost
 * snapshot and the builder's price hint. It is a READ: `avg_cost_p`, `last_cost_p` and the purchase average never carry the extra.
 */
export async function saleCostOf(db: Executor, productId: string, warehouseId: string): Promise<SaleCost> {
  const stockCost = await costOf(db, productId, warehouseId);
  if (!(stockCost > 0)) return saleCostFrom(0, null, "LANDED");
  const [p] = await db.select({ extraP: products.extraP }).from(products).where(eq(products.id, productId));
  return saleCostFrom(stockCost, p?.extraP, await readProfitCostBasis(db));
}

/** The company setting "Allow selling below zero stock" (imported legacy settings, `company_profile.doc.allowNegativeStock`); missing = false. */
export async function allowNegativeStock(db: Executor): Promise<boolean> {
  const [row] = await db.select({ doc: companyProfile.doc }).from(companyProfile).orderBy(asc(companyProfile.id)).limit(1);
  return (row?.doc as { allowNegativeStock?: unknown } | undefined)?.allowNegativeStock === true;
}
