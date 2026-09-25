import { asc, inArray } from "drizzle-orm";
import { purchaseItems, purchases, suppliers, type Executor } from "@farooq/db";
import { milliToQty, paymentStatusOf, type ListPurchasesQuery, type PurchaseListItem, type PurchaseListResponse } from "@farooq/shared";
import { productCategories, purchaseHitsFor, searchPurchases, type PurchaseFilters, type PurchaseSearchRow } from "./purchases.search.js";

/** The purchase list (legacy `PAGES.purchases` + the `Mirror` rows) and what its CSV needs: rows in the order of the search. */

type PurchaseRow = typeof purchases.$inferSelect;
type ItemRow = typeof purchaseItems.$inferSelect;

export interface PurchaseListRow {
  pu: PurchaseRow;
  /** The first line (legacy `items[0]`), or undefined for a purchase without lines. */
  first: ItemRow | undefined;
  supplierNow: string | null;
  paidP: number;
}

/** Loads the purchases named by a search page, in that order, with their first line and the supplier's current name. */
export async function loadPurchaseListRows(db: Executor, found: PurchaseSearchRow[]): Promise<PurchaseListRow[]> {
  if (found.length === 0) return [];
  const ids = found.map((r) => r.id);
  const rows = await db.select().from(purchases).where(inArray(purchases.id, ids));
  const items = await db.select().from(purchaseItems).where(inArray(purchaseItems.purchaseId, ids)).orderBy(asc(purchaseItems.sortOrder), asc(purchaseItems.id));
  const firstOf = new Map<string, ItemRow>();
  for (const it of items) if (!firstOf.has(it.purchaseId)) firstOf.set(it.purchaseId, it);
  const supIds = [...new Set(rows.map((r) => r.supplierId).filter((x): x is string => Boolean(x)))];
  const sups = supIds.length ? await db.select({ id: suppliers.id, name: suppliers.companyName }).from(suppliers).where(inArray(suppliers.id, supIds)) : [];
  const supName = new Map(sups.map((s) => [s.id, s.name]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return found.flatMap((f) => {
    const pu = byId.get(f.id);
    return pu ? [{ pu, first: firstOf.get(pu.id), supplierNow: pu.supplierId ? (supName.get(pu.supplierId) ?? null) : null, paidP: f.paidP }] : [];
  });
}

const toItem = (r: PurchaseListRow, hits: PurchaseListItem["hits"]): PurchaseListItem => {
  const p = r.pu;
  const printed = p.supplierNameSnapshot ?? r.supplierNow;
  return {
    id: p.id,
    number: p.purchaseNumber,
    date: p.date,
    status: p.status,
    paymentStatus: paymentStatusOf(p.totalP, r.paidP),
    supplierId: p.supplierId,
    supplierName: printed,
    supplierCurrentName: r.supplierNow && r.supplierNow !== printed ? r.supplierNow : null,
    supplierInvoiceNo: p.supplierInvoiceNo || null,
    warehouse: p.warehouseSnapshot,
    firstLine: r.first
      ? {
          name: r.first.descriptionEnSnapshot || r.first.descriptionSnapshot || "",
          nameUr: r.first.descriptionSnapshot && r.first.descriptionSnapshot !== r.first.descriptionEnSnapshot ? r.first.descriptionSnapshot : null,
          package: r.first.packageSnapshot,
          unitPriceP: r.first.unitPriceP,
        }
      : null,
    lineCount: p.lineCount,
    orderedQuantity: milliToQty(p.orderedQtyMilli),
    receivedQuantity: milliToQty(p.receivedQtyMilli),
    totalP: p.totalP,
    paidP: r.paidP,
    balanceP: p.totalP - r.paidP,
    hits,
  };
};

/** `GET /purchases`. See purchases.search.ts. */
export async function listPurchases(db: Executor, q: ListPurchasesQuery): Promise<PurchaseListResponse> {
  const { limit, offset, ...filters } = q;
  const found = await searchPurchases(db, filters as PurchaseFilters, { limit, offset });
  const rows = await loadPurchaseListRows(db, found.rows);
  const hits = await purchaseHitsFor(db, rows.map((r) => r.pu.id), found.interpreted.terms);
  return {
    items: rows.map((r) => toItem(r, hits.get(r.pu.id) ?? null)),
    total: found.total,
    limit,
    offset,
    interpreted: found.interpreted,
    kpis: found.kpis,
    payFacets: found.payFacets,
    categories: await productCategories(db),
    onFile: found.onFile,
  };
}
