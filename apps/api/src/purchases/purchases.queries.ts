import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { payments, paymentAllocations, purchaseItems, purchases, readProfitCostBasis, returns, stockLevels, stockMovements, suppliers, warehouses, type Executor } from "@farooq/db";
import {
  milliToQty,
  paymentStatusOf,
  PURCHASE_MESSAGES,
  roleHasPermission,
  type PurchaseAction,
  type PurchaseDetail,
  type PurchaseRate,
  type Role,
} from "@farooq/shared";
import { supplierBalance } from "../payments/payments.queries.js";
import { supplierLockedByPayments, supplierLockedByReturns } from "./rules.js";

/** Read side of purchases. Every function takes an `Executor` (the pool or an open transaction). */

type PurchaseRow = typeof purchases.$inferSelect;

/** Allocated to this purchase by POSTED vouchers (a reversed voucher keeps its allocation rows but no longer counts). Legacy `Purchases.paidFor`. */
export async function paidOn(db: Executor, purchaseId: string): Promise<number> {
  const rows = await db.execute<{ paid: string }>(sql`
    SELECT COALESCE(SUM(a.amount_p), 0)::text AS paid
    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
    WHERE a.purchase_id = ${purchaseId} AND p.status = 'POSTED'`);
  return Number([...rows][0]?.paid ?? 0);
}

export interface VoucherOnPurchase {
  paymentId: string;
  receiptNumber: string;
  date: string;
  method: string | null;
  reference: string | null;
  status: string;
  allocatedP: number;
}

/** Every voucher with an allocation on this purchase, oldest first (legacy `paymentsFor` lists the non-reversed ones; callers filter). */
export async function vouchersOn(db: Executor, purchaseId: string): Promise<VoucherOnPurchase[]> {
  const rows = await db
    .select({
      paymentId: payments.id,
      receiptNumber: payments.receiptNumber,
      date: payments.paymentDate,
      method: payments.method,
      reference: payments.reference,
      status: payments.status,
      createdAt: payments.createdAt,
      allocatedP: sql<string>`SUM(${paymentAllocations.amountP})::text`,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(eq(paymentAllocations.purchaseId, purchaseId))
    .groupBy(payments.id)
    .orderBy(asc(payments.paymentDate), asc(payments.createdAt), asc(payments.id));
  return rows.map((r) => ({ paymentId: r.paymentId, receiptNumber: r.receiptNumber, date: r.date, method: r.method, reference: r.reference, status: r.status, allocatedP: Number(r.allocatedP) }));
}

const allowed: PurchaseAction = { allowed: true, reason: null };
const refused = (reason: string): PurchaseAction => ({ allowed: false, reason });

/** Legacy `canEdit`: not cancelled, and PURCHASE_CREATE or TRANSACTION_CORRECT. */
export const canEditPurchases = (role: Role): boolean => roleHasPermission(role, "PURCHASE_CREATE") || roleHasPermission(role, "TRANSACTION_CORRECT");

export function editAction(pu: Pick<PurchaseRow, "status">, role: Role): PurchaseAction {
  if (pu.status === "CANCELLED") return refused(PURCHASE_MESSAGES.cancelledEdit);
  if (!canEditPurchases(role)) return refused(PURCHASE_MESSAGES.noPermissionEdit);
  return allowed;
}

/**
 * Why the supplier on this purchase may not be swapped, or null (legacy `supplierLockReason`): the vouchers and returns written against
 * it belong to that supplier. Used by the save (inside its transaction) and by the detail's `actions.changeSupplier`.
 */
export async function supplierLockReason(
  db: Executor,
  pu: Pick<PurchaseRow, "id" | "legacyId">,
  items: readonly { returnedQtyMilli: number }[],
): Promise<string | null> {
  const pays = (await vouchersOn(db, pu.id)).filter((v) => v.status !== "REVERSED");
  if (pays.length) return supplierLockedByPayments(pays.map((p) => p.receiptNumber));
  // supplier returns are M5's: they carry the purchase in their legacy document until M5 gives them a column of their own
  const rets = pu.legacyId
    ? await db
        .select({ number: returns.returnNumber })
        .from(returns)
        .where(and(eq(returns.kind, "SUPPLIER"), sql`${returns.status} <> 'CANCELLED'`, sql`${returns.legacyDoc}->>'purchaseId' = ${pu.legacyId}`))
    : [];
  const numbers = rets.map((r) => r.number ?? "(no number)");
  if (!numbers.length && items.some((i) => i.returnedQtyMilli > 0)) numbers.push("(no number)");
  return numbers.length ? supplierLockedByReturns(numbers) : null;
}

/** (S13) Whether an edit may put this purchase on another supplier: the edit rules first, then the lock. */
export async function changeSupplierAction(db: Executor, pu: PurchaseRow, items: readonly { returnedQtyMilli: number }[], role: Role): Promise<PurchaseAction> {
  const edit = editAction(pu, role);
  if (!edit.allowed) return edit;
  const lock = await supplierLockReason(db, pu, items);
  return lock ? refused(lock) : allowed;
}

/** The purchase with its lines, vouchers, stock movements and what `role` may do. Null when there is no such purchase. */
export async function loadPurchaseDetail(db: Executor, id: string, role: Role): Promise<PurchaseDetail | null> {
  const [pu] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  if (!pu) return null;
  const canSeeCost = roleHasPermission(role, "PROFIT_VIEW");

  const items = await db.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, id)).orderBy(asc(purchaseItems.sortOrder), asc(purchaseItems.id));
  const whs = await db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses);
  const whName = new Map(whs.map((w) => [w.id, w.name]));
  const supplierRow = pu.supplierId ? (await db.select({ name: suppliers.companyName }).from(suppliers).where(eq(suppliers.id, pu.supplierId)).limit(1))[0] : undefined;
  const supplierBalanceP = pu.supplierId ? await supplierBalance(db, pu.supplierId) : null;

  const movements = await db
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.sourceType, "PURCHASE"), eq(stockMovements.sourceId, id)))
    .orderBy(asc(stockMovements.date), asc(stockMovements.createdAt), asc(stockMovements.id));
  const vouchers = await vouchersOn(db, id);
  const paidP = await paidOn(db, id);

  const itemDiscountsP = items.reduce((a, i) => a + i.discountP, 0);

  let costs: PurchaseDetail["costs"];
  if (canSeeCost) {
    const pairs = [...new Map(items.map((i) => [`${i.productId}:${i.warehouseId}`, i])).values()];
    const levels = pairs.length
      ? await db
          .select({ productId: stockLevels.productId, warehouseId: stockLevels.warehouseId, avgCostP: stockLevels.avgCostP, lastCostP: stockLevels.lastCostP })
          .from(stockLevels)
          .where(and(eq(stockLevels.bucket, "stock"), inArray(stockLevels.productId, [...new Set(pairs.map((p) => p.productId))]), inArray(stockLevels.warehouseId, [...new Set(pairs.map((p) => p.warehouseId))])))
      : [];
    const wanted = new Set(pairs.map((p) => `${p.productId}:${p.warehouseId}`));
    costs = {
      basis: await readProfitCostBasis(db),
      stock: levels.filter((l) => wanted.has(`${l.productId}:${l.warehouseId}`)).sort((a, b) => (`${a.productId}:${a.warehouseId}` < `${b.productId}:${b.warehouseId}` ? -1 : 1)),
    };
  }

  return {
    id: pu.id,
    number: pu.purchaseNumber,
    status: pu.status,
    paymentStatus: paymentStatusOf(pu.totalP, paidP),
    date: pu.date,
    supplierId: pu.supplierId,
    supplierName: pu.supplierNameSnapshot ?? supplierRow?.name ?? null,
    supplierInvoiceNo: pu.supplierInvoiceNo,
    warehouseId: pu.warehouseId,
    warehouseName: pu.warehouseSnapshot ?? (pu.warehouseId ? (whName.get(pu.warehouseId) ?? null) : null),
    vehicleNo: pu.vehicleNo,
    driver: pu.driver,
    deliveryRef: pu.deliveryRef,
    subtotalP: pu.subtotalP,
    itemDiscountsP,
    invoiceDiscountP: Math.max(0, pu.discountAmountP - itemDiscountsP),
    discountAmountP: pu.discountAmountP,
    taxP: pu.taxP,
    freightP: pu.freightP,
    loadingP: pu.loadingP,
    otherChargesP: pu.otherChargesP,
    totalP: pu.totalP,
    paidP,
    balanceP: pu.totalP - paidP,
    notes: pu.notes,
    description: pu.description,
    orderedQuantity: milliToQty(pu.orderedQtyMilli),
    receivedQuantity: milliToQty(pu.receivedQtyMilli),
    lineCount: pu.lineCount,
    stockApplied: pu.stockApplied,
    migrated: pu.migrated,
    revision: pu.revision,
    createdBy: pu.createdBy,
    createdAt: pu.createdAt.toISOString(),
    updatedAt: pu.updatedAt.toISOString(),
    lines: items.map((it) => ({
      id: it.id,
      sortOrder: it.sortOrder,
      productId: it.productId,
      warehouseId: it.warehouseId,
      description: it.descriptionSnapshot,
      descriptionEn: it.descriptionEnSnapshot,
      brand: it.brandSnapshot,
      package: it.packageSnapshot,
      unit: it.unit,
      quantity: milliToQty(it.qtyMilli),
      qtyMilli: it.qtyMilli,
      receivedQuantity: milliToQty(it.receivedQtyMilli),
      receivedQtyMilli: it.receivedQtyMilli,
      returnedQuantity: milliToQty(it.returnedQtyMilli),
      unitPriceP: it.unitPriceP,
      discountP: it.discountP,
      taxP: it.taxP,
      lineTotalP: it.lineTotalP,
      batchNo: it.batchNo,
      notes: it.notes,
      // present ONLY with PROFIT_VIEW — the keys do not exist for anyone else
      ...(canSeeCost ? { goodsUnitCostP: it.goodsUnitCostP, chargeShareP: it.chargeShareP, landedUnitCostP: it.landedUnitCostP, operationalShareP: it.operationalShareP } : {}),
    })),
    payments: vouchers.map((v) => ({ paymentId: v.paymentId, receiptNumber: v.receiptNumber, date: v.date, method: v.method, reference: v.reference, allocatedP: v.allocatedP, status: v.status as "POSTED" | "REVERSED" })),
    stockMovements: movements.map((m) => ({
      id: m.id,
      date: m.date,
      kind: m.kind,
      refType: m.refType,
      ref: m.ref,
      productId: m.productId,
      warehouseId: m.warehouseId,
      bucket: m.bucket,
      quantity: milliToQty(m.qtyDeltaMilli),
      note: m.note,
      ...(canSeeCost ? { unitCostP: m.unitCostP } : {}),
    })),
    actions: { edit: editAction(pu, role), changeSupplier: await changeSupplierAction(db, pu, items, role) },
    supplierCurrentName: supplierRow?.name ?? null,
    supplierBalanceP,
    ...(costs ? { costs } : {}),
  };
}

/**
 * The rate of the most recent non-cancelled purchase line of each product (newest purchase date, then newest entry) — the builder's
 * "last rate" hint. A product never bought is simply absent.
 */
export async function lastPurchaseRates(db: Executor, productIds: string[]): Promise<PurchaseRate[]> {
  if (productIds.length === 0) return [];
  const rows = await db.execute<{ product_id: string; unit_price_p: string; date: string; purchase_number: string | null; supplier_id: string | null }>(sql`
    SELECT DISTINCT ON (pi.product_id) pi.product_id, pi.unit_price_p::text AS unit_price_p, p.date::text AS date, p.purchase_number, p.supplier_id
    FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
    WHERE pi.product_id IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND p.status <> 'CANCELLED'
    ORDER BY pi.product_id, p.date DESC, p.created_at DESC, pi.sort_order DESC, pi.id`);
  return [...rows].map((r) => ({ productId: r.product_id, unitPriceP: Number(r.unit_price_p), date: r.date, purchaseNumber: r.purchase_number, supplierId: r.supplier_id }));
}
