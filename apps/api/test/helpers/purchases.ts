import { randomUUID } from "node:crypto";
import type { Harness, Session } from "./harness.js";
import { seedProduct, seedStock, seedWarehouse } from "./invoices.js";

/** Test helpers for the purchases service (S12). Everything is uniquely named, so no test needs to truncate. */

export interface PurLine {
  productId: string;
  quantity: number;
  unitPriceP: number;
  [k: string]: unknown;
}

/** A save body with the boring fields filled in. */
export const purBody = (supplierId: string, warehouseId: string, lines: PurLine[], extra: Record<string, unknown> = {}) => ({ supplierId, warehouseId, lines, ...extra });

export const newKey = () => `key-${randomUUID()}`;

export const postPur = (h: Harness, as: Session | null, body: unknown) => h.request(as, "POST", "/purchases", { body });
export const putPur = (h: Harness, as: Session | null, id: string, body: unknown) => h.request(as, "PUT", `/purchases/${id}`, { body });
export const getPur = (h: Harness, as: Session | null, id: string) => h.request(as, "GET", `/purchases/${id}`);

/** The body of a PUT that re-sends a purchase's current lines / header with changes (what the builder would send). */
export function purEditBody(pu: any, changes: Record<string, unknown> = {}, lines?: PurLine[]) {
  return {
    supplierId: pu.supplierId,
    warehouseId: pu.warehouseId,
    date: pu.date,
    revision: pu.revision,
    supplierInvoiceNo: pu.supplierInvoiceNo ?? undefined,
    vehicleNo: pu.vehicleNo ?? undefined,
    driver: pu.driver ?? undefined,
    deliveryRef: pu.deliveryRef ?? undefined,
    notes: pu.notes ?? undefined,
    lines:
      lines ??
      pu.lines.map((l: any) => ({
        id: l.id,
        productId: l.productId,
        quantity: l.quantity,
        // blank means "the whole line arrived": only a part delivery is spelled out (the legacy `toDraft`)
        ...(l.receivedQuantity < l.quantity ? { receivedQuantity: l.receivedQuantity } : {}),
        unitPriceP: l.unitPriceP,
        discountP: l.discountP,
        taxP: l.taxP,
        warehouseId: l.warehouseId,
      })),
    invoiceDiscountP: pu.invoiceDiscountP,
    freightP: pu.freightP,
    loadingP: pu.loadingP,
    otherChargesP: pu.otherChargesP,
    ...changes,
  };
}

/** A supplier, a default godown and `products` fresh products, none in stock. */
export async function purScenario(h: Harness, products = 2) {
  const supplier = await h.seed.supplier();
  const wh = await seedWarehouse(h);
  const ps = [];
  for (let i = 0; i < products; i++) ps.push(await seedProduct(h));
  return { supplier, wh, ps };
}

export type PurScenario = Awaited<ReturnType<typeof purScenario>>;

/** A recorded purchase through the API (owner). Returns the purchase detail. */
export async function mkPurchase(h: Harness, as: Session, s: { supplier: { id: string }; wh: { id: string } }, lines: PurLine[], extra: Record<string, unknown> = {}) {
  const r = await postPur(h, as, purBody(s.supplier.id, s.wh.id, lines, extra));
  if (r.status !== 201) throw new Error(`mkPurchase failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

export { seedStock };

/** The stock row's cost figures, straight from SQL. */
export const costsOf = async (h: Harness, productId: string, warehouseId: string): Promise<{ avg: number; last: number } | null> => {
  const rows = await h.admin`SELECT avg_cost_p::text AS avg, last_cost_p::text AS last FROM stock_levels WHERE product_id = ${productId} AND warehouse_id = ${warehouseId} AND bucket = 'stock'`;
  return rows.length ? { avg: Number(rows[0]!.avg), last: Number(rows[0]!.last) } : null;
};

export const purMovements = async (h: Harness, purchaseId: string) => {
  const rows = await h.admin`
    SELECT kind, ref_type, ref, date::text AS date, qty_delta_milli::int AS q, unit_cost_p::text AS cost, product_id, warehouse_id, note, source_type
    FROM stock_movements WHERE source_type = 'PURCHASE' AND source_id = ${purchaseId} ORDER BY created_at, id`;
  return rows.map((r) => ({
    kind: r.kind as string,
    refType: r.ref_type as string,
    ref: r.ref as string,
    date: r.date as string,
    q: r.q as number,
    cost: r.cost === null ? null : Number(r.cost),
    productId: r.product_id as string,
    warehouseId: r.warehouse_id as string,
    note: r.note as string | null,
  }));
};

export const purAudit = async (h: Harness, entityId: string) => h.admin`SELECT action, entity, before, after, actor_id FROM audit_log WHERE entity_id = ${entityId} AND entity = 'Purchase' ORDER BY at, id`;

/** Vouchers written against a purchase, straight from SQL. */
export const vouchersFor = async (h: Harness, purchaseId: string) => {
  const rows = await h.admin`
    SELECT p.receipt_number, p.amount_p::text AS amount, p.method, p.reference, p.note, p.payment_date::text AS date, p.status, a.amount_p::text AS allocated
    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.purchase_id = ${purchaseId} ORDER BY p.created_at, p.id`;
  return rows.map((r) => ({ number: r.receipt_number as string, amount: Number(r.amount), method: r.method as string, reference: r.reference as string | null, note: r.note as string | null, date: r.date as string, status: r.status as string, allocated: Number(r.allocated) }));
};
