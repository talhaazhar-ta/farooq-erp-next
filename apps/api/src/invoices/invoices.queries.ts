import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { invoiceItems, invoices, payments, products, stockLevels, stockMovements, warehouses, type Executor } from "@farooq/db";
import {
  INVOICE_MESSAGES,
  milliToQty,
  paymentStatusOf,
  roleHasPermission,
  type InvoiceAction,
  type InvoiceDetail,
  type ProductPickItem,
  type ProductPickQuery,
  type Role,
  type WarehouseItem,
} from "@farooq/shared";
import { costOf } from "./stock.js";
import { activeReturns, cancelRefusal, changeShopRefusals, editRefusal, receiptsOn } from "./rules.js";

/** Read side of invoices. Every function takes an `Executor` (the pool or an open transaction). */

type InvoiceRow = typeof invoices.$inferSelect;

const allowed: InvoiceAction = { allowed: true, reason: null };
const refused = (reason: string): InvoiceAction => ({ allowed: false, reason });

/** Allocated to this invoice by POSTED receipts (a reversed receipt keeps its allocation rows but no longer counts). */
export async function paidOn(db: Executor, invoiceId: string): Promise<number> {
  const rows = await db.execute<{ paid: string }>(sql`
    SELECT COALESCE(SUM(a.amount_p), 0)::text AS paid
    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
    WHERE a.invoice_id = ${invoiceId} AND p.status = 'POSTED'`);
  return Number([...rows][0]?.paid ?? 0);
}

async function creditOn(db: Executor, invoiceId: string): Promise<number> {
  const rows = await db.execute<{ credit: string }>(sql`
    SELECT COALESCE(SUM(total_p), 0)::text AS credit FROM returns
    WHERE invoice_id = ${invoiceId} AND kind = 'CUSTOMER' AND status <> 'CANCELLED'`);
  return Number([...rows][0]?.credit ?? 0);
}

/** The invoice with its lines, receipts, stock movements, and which actions `role` may take and why not. Null when there is no such invoice. */
export async function loadInvoiceDetail(db: Executor, id: string, role: Role): Promise<InvoiceDetail | null> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!inv) return null;
  const canSeeCost = roleHasPermission(role, "PROFIT_VIEW");

  const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.sortOrder), asc(invoiceItems.id));
  const whs = await db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses);
  const whName = new Map(whs.map((w) => [w.id, w.name]));

  const receipts = await receiptsOn(db, id);
  const movements = await db
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.sourceType, "INVOICE"), eq(stockMovements.sourceId, id)))
    .orderBy(asc(stockMovements.date), asc(stockMovements.createdAt), asc(stockMovements.id));

  const paidP = await paidOn(db, id);
  const creditP = await creditOn(db, id);
  const receiptRows = receipts.length
    ? await db.select({ id: payments.id, method: payments.method, reference: payments.reference }).from(payments).where(inArray(payments.id, receipts.map((r) => r.paymentId)))
    : [];
  const receiptExtra = new Map(receiptRows.map((r) => [r.id, r]));

  return {
    id: inv.id,
    number: inv.invoiceNumber,
    status: inv.status,
    paymentStatus: paymentStatusOf(inv.totalP, paidP),
    invoiceType: inv.invoiceType,
    date: inv.date,
    dueDate: inv.dueDate,
    customerId: inv.customerId,
    shop: {
      code: inv.customerCodeSnapshot,
      name: inv.customerNameSnapshot,
      shopName: inv.shopNameSnapshot,
      contactPerson: inv.contactPersonSnapshot,
      mobile: inv.mobileSnapshot,
      whatsapp: inv.whatsappSnapshot,
      address: inv.addressSnapshot,
      regionId: inv.regionId,
      region: inv.regionSnapshot,
      market: inv.marketSnapshot,
    },
    warehouseId: inv.warehouseId,
    warehouseName: inv.warehouseSnapshot ?? (inv.warehouseId ? (whName.get(inv.warehouseId) ?? null) : null),
    salesperson: inv.salesperson,
    orderNumber: inv.orderNumber,
    dispatchNumber: inv.dispatchNumber,
    subtotalP: inv.subtotalP,
    itemDiscountsP: inv.itemDiscountsP,
    invoiceDiscountP: inv.invoiceDiscountP,
    discountAmountP: inv.itemDiscountsP + inv.invoiceDiscountP,
    taxP: inv.taxP,
    freightP: inv.freightP,
    loadingP: inv.loadingP,
    otherChargesP: inv.otherChargesP,
    totalP: inv.totalP,
    paidP,
    balanceP: inv.totalP - paidP,
    outstandingP: inv.totalP - paidP - creditP,
    paymentMethod: inv.paymentMethod,
    referenceNo: inv.referenceNo,
    notes: inv.notes,
    description: inv.description,
    previousBalanceP: inv.previousBalanceP,
    totalQuantity: milliToQty(inv.totalQtyMilli),
    lineCount: inv.lineCount,
    stockApplied: inv.stockApplied,
    migrated: inv.migrated,
    revision: inv.revision,
    createdBy: inv.createdBy,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
    confirmedAt: inv.confirmedAt ? inv.confirmedAt.toISOString() : null,
    cancelledAt: inv.cancelledAt ? inv.cancelledAt.toISOString() : null,
    cancelReason: inv.cancelReason,
    lines: items.map((it) => ({
      id: it.id,
      sortOrder: it.sortOrder,
      productId: it.productId,
      warehouseId: it.warehouseId,
      description: it.descriptionSnapshot,
      descriptionEn: it.descriptionEnSnapshot,
      brand: it.brandSnapshot,
      category: it.categorySnapshot,
      package: it.packageSnapshot,
      sku: it.skuSnapshot,
      unit: it.unit,
      quantity: milliToQty(it.qtyMilli),
      qtyMilli: it.qtyMilli,
      unitPriceP: it.unitPriceP,
      discountP: it.discountP,
      taxP: it.taxP,
      lineTotalP: it.lineTotalP,
      returnedQuantity: milliToQty(it.returnedQtyMilli),
      costSnapshotP: canSeeCost ? it.costSnapshotP : null,
      batchNo: it.batchNo,
      notes: it.notes,
    })),
    receipts: receipts.map((r) => ({
      paymentId: r.paymentId,
      receiptNumber: r.receiptNumber,
      date: r.date,
      method: receiptExtra.get(r.paymentId)?.method ?? null,
      reference: receiptExtra.get(r.paymentId)?.reference ?? null,
      allocatedP: r.allocatedToThisP,
      status: r.status as "POSTED" | "REVERSED",
    })),
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
    })),
    actions: await actionsFor(db, inv, role),
  };
}

/** Which of edit / cancel / change shop / duplicate `role` may take on this invoice, with the server's own reason when not. */
async function actionsFor(db: Executor, inv: InvoiceRow, role: Role): Promise<InvoiceDetail["actions"]> {
  const rules = {
    id: inv.id,
    status: inv.status,
    customerId: inv.customerId,
    number: inv.invoiceNumber,
    shopNameSnapshot: inv.shopNameSnapshot,
    dispatchNumber: inv.dispatchNumber,
    totalP: inv.totalP,
  };
  const can = (p: "SALES_CREATE" | "TRANSACTION_CORRECT"): boolean => roleHasPermission(role, p);

  let edit: InvoiceAction;
  if (inv.status === "CANCELLED") edit = refused(INVOICE_MESSAGES.cancelledEdit);
  else if (inv.status === "DRAFT") edit = can("SALES_CREATE") ? allowed : refused(INVOICE_MESSAGES.noPermissionPost);
  else if (!can("TRANSACTION_CORRECT")) edit = refused(INVOICE_MESSAGES.noPermissionCorrect);
  else {
    const why = await editRefusal(db, rules);
    edit = why ? refused(why) : allowed;
  }

  let cancel: InvoiceAction;
  if (!can("TRANSACTION_CORRECT") && !(inv.status === "DRAFT" && can("SALES_CREATE"))) cancel = refused(INVOICE_MESSAGES.noPermissionCorrect);
  else {
    const why = await cancelRefusal(db, rules);
    cancel = why ? refused(why) : allowed;
  }

  let changeShop: InvoiceAction;
  if (!can("TRANSACTION_CORRECT")) changeShop = refused(INVOICE_MESSAGES.noPermissionCorrect);
  else {
    const why = await changeShopRefusals(db, rules);
    changeShop = why.length ? refused(why[0]!) : allowed;
  }

  const duplicate = can("SALES_CREATE") ? allowed : refused(INVOICE_MESSAGES.noPermissionPost);
  return { edit, cancel, changeShop, duplicate };
}

export async function returnNumbers(db: Executor, invoiceId: string): Promise<string[]> {
  return (await activeReturns(db, invoiceId)).map((r) => r.number ?? "(no number)");
}

/* ── pickers ─────────────────────────────────────────────────────────── */

export async function listWarehouses(db: Executor): Promise<WarehouseItem[]> {
  return db.select({ id: warehouses.id, name: warehouses.name, active: warehouses.active }).from(warehouses).orderBy(asc(warehouses.name), asc(warehouses.id));
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The invoice builder's product search (legacy `searchProducts` + `lastRate`): active products whose name / Urdu name / brand /
 * category / SKU / bag size contains every typed word; in-stock (in `warehouseId`) first, then by English name; at most `limit`.
 * Cost figures only for PROFIT_VIEW.
 */
export async function pickProducts(db: Executor, query: ProductPickQuery, role: Role): Promise<ProductPickItem[]> {
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const hay = sql`lower(concat_ws(' ', ${products.name}, ${products.nameEn}, ${products.nameUr}, ${products.brand}, ${products.brandEn}, ${products.category}, ${products.sku}, ${products.legacyId}, CASE WHEN ${products.weightKg} IS NOT NULL THEN ${products.weightKg}::text || ' kg' END))`;
  const conds = [eq(products.active, true), ...words.map((w) => sql`${hay} LIKE ${`%${likeEscape(w)}%`}`)];
  const rows = await db
    .select()
    .from(products)
    .where(and(...conds))
    .orderBy(asc(sql`lower(COALESCE(${products.nameEn}, ${products.name}))`), asc(products.id))
    .limit(1000);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const levels = await db
    .select({ productId: stockLevels.productId, warehouseId: stockLevels.warehouseId, qtyMilli: stockLevels.qtyMilli })
    .from(stockLevels)
    .where(and(inArray(stockLevels.productId, ids), eq(stockLevels.bucket, "stock")));
  const byProduct = new Map<string, { warehouseId: string; qtyMilli: number }[]>();
  for (const l of levels) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);

  const availableHere = (id: string): number => (query.warehouseId ? (byProduct.get(id) ?? []).find((l) => l.warehouseId === query.warehouseId)?.qtyMilli ?? 0 : 0);
  const sorted = query.warehouseId
    ? [...rows].sort((a, b) => {
        const sa = availableHere(a.id) > 0;
        const sb = availableHere(b.id) > 0;
        return sa === sb ? 0 : sa ? -1 : 1; // stable: name order is kept inside each group
      })
    : rows;
  const page = sorted.slice(0, query.limit);

  // the rate of the most recent posted, non-cancelled line (legacy `lastRate`)
  const last = await db.execute<{ product_id: string; unit_price_p: string }>(sql`
    SELECT DISTINCT ON (ii.product_id) ii.product_id, ii.unit_price_p::text AS unit_price_p
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE ii.product_id IN (${sql.join(page.map((p) => sql`${p.id}::uuid`), sql`, `)}) AND i.status NOT IN ('CANCELLED', 'DRAFT')
    ORDER BY ii.product_id, i.date DESC, i.created_at DESC`);
  const lastRate = new Map([...last].map((r) => [r.product_id, Number(r.unit_price_p)]));

  const showCost = roleHasPermission(role, "PROFIT_VIEW");
  const out: ProductPickItem[] = [];
  for (const p of page) {
    const here = query.warehouseId ?? (byProduct.get(p.id) ?? [])[0]?.warehouseId;
    out.push({
      id: p.id,
      name: p.name,
      nameEn: p.nameEn,
      nameUr: p.nameUr,
      brand: p.brandEn ?? p.brand,
      category: p.category,
      unit: p.unit,
      weightKg: p.weightKg,
      sku: p.sku,
      sellP: p.sellP,
      minSellP: p.minSellP,
      lastRateP: lastRate.get(p.id) ?? null,
      taxPct: p.taxPct,
      available: (byProduct.get(p.id) ?? []).map((l) => ({ warehouseId: l.warehouseId, quantity: milliToQty(l.qtyMilli) })),
      costP: showCost && here ? await costOf(db, p.id, here) : null,
      buyP: showCost ? p.buyP : null,
    });
  }
  return out;
}
