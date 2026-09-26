import { randomUUID } from "node:crypto";
import { products, stockLevels, stockMovements, warehouses } from "@farooq/db";
import type { Harness, Session } from "./harness.js";

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

export async function seedWarehouse(h: Harness, name = `Godown ${uniq()}`) {
  const [w] = await h.db.insert(warehouses).values({ name }).returning();
  return w!;
}

export async function seedProduct(
  h: Harness,
  o: Partial<{ name: string; nameEn: string; nameUr: string; brand: string; category: string; weightKg: number; sellP: number; buyP: number; extraP: number; minSellP: number; sku: string; taxPct: number }> = {},
) {
  const name = o.name ?? `Rice ${uniq()}`;
  const [p] = await h.db
    .insert(products)
    .values({
      name,
      nameEn: o.nameEn ?? name,
      nameUr: o.nameUr ?? null,
      brand: o.brand ?? null,
      category: o.category ?? "Rice",
      unit: "Bag",
      weightKg: o.weightKg ?? 50,
      sellP: o.sellP ?? null,
      buyP: o.buyP ?? null,
      extraP: o.extraP ?? null,
      minSellP: o.minSellP ?? null,
      sku: o.sku ?? null,
      taxPct: o.taxPct ?? null,
    })
    .returning();
  return p!;
}

/** Puts bags in a godown the way an opening-stock movement would: a level row AND the movement that explains it (level = Σ movements). */
export async function seedStock(
  h: Harness,
  productId: string,
  warehouseId: string,
  qty: number,
  o: { avgCostP?: number; movementCostP?: number; kind?: string } = {},
) {
  const qtyMilli = Math.round(qty * 1000);
  await h.db.insert(stockLevels).values({ productId, warehouseId, bucket: "stock", qtyMilli, avgCostP: o.avgCostP ?? 0 });
  await h.db.insert(stockMovements).values({
    date: "2026-01-01",
    productId,
    warehouseId,
    kind: o.kind ?? "OPENING_STOCK",
    bucket: "stock",
    qtyDeltaMilli: qtyMilli,
    unitCostP: o.movementCostP ?? null,
    ref: "opening",
    refType: "MIGRATION",
  });
}

export const levelOf = async (h: Harness, productId: string, warehouseId: string): Promise<number | null> => {
  const rows = await h.admin`SELECT qty_milli::text AS q FROM stock_levels WHERE product_id = ${productId} AND warehouse_id = ${warehouseId} AND bucket = 'stock'`;
  return rows.length ? Number(rows[0]!.q) : null;
};

export const movementsOf = async (h: Harness, invoiceId: string) => {
  const rows = await h.admin`
    SELECT kind, ref_type, ref, date::text AS date, qty_delta_milli::int AS q, product_id, warehouse_id, note
    FROM stock_movements WHERE source_type = 'INVOICE' AND source_id = ${invoiceId} ORDER BY created_at, id`;
  return rows.map((r) => ({ kind: r.kind as string, refType: r.ref_type as string, ref: r.ref as string, date: r.date as string, q: r.q as number, productId: r.product_id as string, warehouseId: r.warehouse_id as string, note: r.note as string | null }));
};

/** Σ movements for a pair == the level (the reconciliation's promise), read straight from SQL. */
export const movementSum = async (h: Harness, productId: string, warehouseId: string): Promise<number> => {
  const rows = await h.admin`SELECT COALESCE(SUM(qty_delta_milli), 0)::text AS s FROM stock_movements WHERE product_id = ${productId} AND warehouse_id = ${warehouseId} AND bucket = 'stock'`;
  return Number(rows[0]!.s);
};

export interface BodyLine {
  productId: string;
  quantity: number;
  unitPriceP: number;
  [k: string]: unknown;
}

/** A save body with the boring fields filled in. */
export const invBody = (customerId: string, warehouseId: string, lines: BodyLine[], extra: Record<string, unknown> = {}) => ({
  mode: "post",
  customerId,
  warehouseId,
  lines,
  ...extra,
});

export const newKey = () => `key-${randomUUID()}`;

export const post = (h: Harness, as: Session | null, body: unknown) => h.request(as, "POST", "/invoices", { body });
export const put = (h: Harness, as: Session | null, id: string, body: unknown) => h.request(as, "PUT", `/invoices/${id}`, { body });
export const get = (h: Harness, as: Session | null, id: string) => h.request(as, "GET", `/invoices/${id}`);
export const cancel = (h: Harness, as: Session | null, id: string, reason = "wrong order") => h.request(as, "POST", `/invoices/${id}/cancel`, { body: { reason } });
export const changeShop = (h: Harness, as: Session | null, id: string, customerId: string, extra: Record<string, unknown> = {}) =>
  h.request(as, "POST", `/invoices/${id}/change-shop`, { body: { customerId, ...extra } });
export const duplicate = (h: Harness, as: Session | null, id: string, body: unknown = {}) => h.request(as, "POST", `/invoices/${id}/duplicate`, { body });

/** Everything a scenario usually needs: a shop, a godown, a product with `stock` bags in it. */
export async function scenario(h: Harness, o: { stock?: number; buyP?: number; productOpts?: Parameters<typeof seedProduct>[1] } = {}) {
  const shop = await h.seed.customer();
  const wh = await seedWarehouse(h);
  const product = await seedProduct(h, { buyP: o.buyP ?? 240_000, ...(o.productOpts ?? {}) });
  await seedStock(h, product.id, wh.id, o.stock ?? 100);
  return { shop, wh, product };
}

export type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * A posted invoice the way the IMPORTER leaves one: header, one line and its journal entry. `migrated` = the old app's data
 * migration (stock_applied but no movement); otherwise its SALE_OUT movement is written too and the godown level reduced.
 */
export async function seedLegacyInvoice(h: Harness, s: Scenario, o: { qty?: number; unitPriceP?: number; migrated?: boolean; date?: string } = {}) {
  const qty = o.qty ?? 4;
  const unitPriceP = o.unitPriceP ?? 10_000;
  const total = qty * unitPriceP;
  const inv = await h.seed.invoice(s.shop.id, { totalP: total, number: `INV-OLD-${uniq()}`, date: o.date ?? "2026-02-01" });
  await h.admin`UPDATE invoices SET migrated = ${o.migrated ?? false}, stock_applied = true, warehouse_id = ${s.wh.id}, subtotal_p = ${total}, total_qty_milli = ${qty * 1000}, line_count = 1, revision = 3 WHERE id = ${inv.id}`;
  await h.admin`INSERT INTO invoice_items (invoice_id, product_id, warehouse_id, qty_milli, unit_price_p, line_total_p, sort_order) VALUES (${inv.id}, ${s.product.id}, ${s.wh.id}, ${qty * 1000}, ${unitPriceP}, ${total}, 0)`;
  if (!o.migrated) {
    await h.admin`INSERT INTO stock_movements (date, product_id, warehouse_id, kind, bucket, qty_delta_milli, ref, ref_type, source_type, source_id) VALUES (${o.date ?? "2026-02-01"}, ${s.product.id}, ${s.wh.id}, 'SALE_OUT', 'stock', ${-qty * 1000}, ${inv.invoiceNumber}, 'INVOICE', 'INVOICE', ${inv.id})`;
    await h.admin`UPDATE stock_levels SET qty_milli = qty_milli - ${qty * 1000} WHERE product_id = ${s.product.id} AND warehouse_id = ${s.wh.id}`;
  }
  return inv;
}

/** A posted invoice through the API: `qty` bags at `unitPriceP`, optionally paid. Returns the invoice detail. */
export async function mkPosted(
  h: Harness,
  as: Session,
  s: { shop: { id: string }; wh: { id: string }; product: { id: string } },
  o: { qty?: number; unitPriceP?: number; paidAmountP?: number; extra?: Record<string, unknown> } = {},
) {
  const line = { productId: s.product.id, quantity: o.qty ?? 10, unitPriceP: o.unitPriceP ?? 200_000 };
  const r = await post(h, as, invBody(s.shop.id, s.wh.id, [line], { ...(o.paidAmountP ? { paidAmountP: o.paidAmountP } : {}), ...(o.extra ?? {}) }));
  if (r.status !== 201) throw new Error(`mkPosted failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** The body of a PUT that re-sends an invoice's current lines / header with changes (what the builder would send). */
export function editBody(inv: any, changes: Record<string, unknown> = {}, lines?: BodyLine[]) {
  return {
    mode: "post",
    customerId: inv.customerId,
    warehouseId: inv.warehouseId,
    date: inv.date,
    revision: inv.revision,
    lines: lines ?? inv.lines.map((l: any) => ({ id: l.id, productId: l.productId, quantity: l.quantity, unitPriceP: l.unitPriceP, discountP: l.discountP, taxP: l.taxP, warehouseId: l.warehouseId })),
    invoiceDiscountP: inv.invoiceDiscountP,
    freightP: inv.freightP,
    loadingP: inv.loadingP,
    otherChargesP: inv.otherChargesP,
    ...changes,
  };
}
