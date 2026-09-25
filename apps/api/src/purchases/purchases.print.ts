import { asc, eq, inArray } from "drizzle-orm";
import { purchaseItems, purchases, warehouses, type Executor } from "@farooq/db";
import {
  amountInWords,
  formatBusinessDate,
  formatMoney,
  formatPaisaPlain,
  formatQtyMilli,
  INVOICE_STATUS_LABELS,
  paymentStatusOf,
  PURCHASE_PRINT_LABELS,
  type PurchasePrint,
} from "@farooq/shared";
import { loadCompany } from "../statements/statements.queries.js";
import { paidOn, vouchersOn } from "./purchases.queries.js";

/**
 * The printed purchase — the legacy `DocModel.purchase` (04-documents.js), built from the database, never from a form.
 *  - fix 4: the strip shows "Bags ordered" AND "Bags received" (the legacy printed the ordered total under "Bags received"), and the lines
 *    have an Ordered and a Received column instead of one "Qty";
 *  - totals: Subtotal, then Discounts / Tax / Freight / Loading / Other charges only when not zero, then Grand total, Paid, Payable to
 *    supplier. "Paid" is what POSTED vouchers applied to this bill (the legacy printed its stored `paidAmount`); the Tax row is new (the
 *    legacy's grand total included line tax that no row showed);
 *  - status: the payment status as the legacy words it; a cancelled purchase carries `cancelled` for the stamp.
 */

const qty = (milli: number): string => formatQtyMilli(milli);

/** `GET /purchases/:id/print`. Null when there is no such purchase. */
export async function loadPurchasePrint(db: Executor, id: string): Promise<PurchasePrint | null> {
  const [pu] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  if (!pu) return null;
  const items = await db.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, id)).orderBy(asc(purchaseItems.sortOrder), asc(purchaseItems.id));
  const whIds = [...new Set(items.map((i) => i.warehouseId))];
  const whs = whIds.length ? await db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses).where(inArray(warehouses.id, whIds)) : [];
  const whName = new Map(whs.map((w) => [w.id, w.name]));
  const company = await loadCompany(db);
  const L = PURCHASE_PRINT_LABELS;
  const T = L.totals;

  const paidP = await paidOn(db, id);
  const vouchers = (await vouchersOn(db, id)).filter((v) => v.status === "POSTED");
  const payStatus = paymentStatusOf(pu.totalP, paidP);
  const number = pu.purchaseNumber ?? "";

  const totals: PurchasePrint["totals"] = [];
  const row = (key: string, label: string, amountP: number, text: string, o: Partial<{ big: boolean; bold: boolean }> = {}) =>
    totals.push({ key, label, amountP, text, big: o.big ?? false, bold: o.bold ?? false });
  row("subtotal", T.subtotal, pu.subtotalP, formatMoney(pu.subtotalP));
  if (pu.discountAmountP) row("discounts", T.discounts, pu.discountAmountP, "− " + formatMoney(pu.discountAmountP));
  if (pu.taxP) row("tax", T.tax, pu.taxP, formatMoney(pu.taxP));
  if (pu.freightP) row("freight", T.freight, pu.freightP, formatMoney(pu.freightP));
  if (pu.loadingP) row("loading", T.loading, pu.loadingP, formatMoney(pu.loadingP));
  if (pu.otherChargesP) row("other", T.other, pu.otherChargesP, formatMoney(pu.otherChargesP));
  row("grand", T.grand, pu.totalP, formatMoney(pu.totalP), { big: true });
  row("paid", T.paid, paidP, formatMoney(paidP));
  row("payable", T.payable, pu.totalP - paidP, formatMoney(pu.totalP - paidP), { bold: true });

  const lineGoodsP = items.reduce((a, it) => a + it.lineTotalP, 0);

  return {
    kind: "PURCHASE",
    title: L.title,
    purchaseId: pu.id,
    number,
    status: INVOICE_STATUS_LABELS[payStatus],
    statusKey: pu.status,
    cancelled: pu.status === "CANCELLED",
    date: pu.date,
    company,
    party: { label: L.supplier, supplierId: pu.supplierId, name: pu.supplierNameSnapshot },
    metaLabel: L.meta,
    meta: [
      { label: L.metaRows.number, value: number, strong: true },
      { label: L.metaRows.supplierInvoice, value: pu.supplierInvoiceNo || "—", strong: false },
      { label: L.metaRows.date, value: formatBusinessDate(pu.date), strong: false },
      { label: L.metaRows.warehouse, value: pu.warehouseSnapshot || "", strong: false },
      { label: L.metaRows.vehicle, value: pu.vehicleNo || "—", strong: false },
      { label: L.metaRows.driver, value: pu.driver || "", strong: false },
    ],
    strip: [
      { label: L.strip.paymentStatus, value: INVOICE_STATUS_LABELS[payStatus] },
      { label: L.stripOrdered, value: qty(pu.orderedQtyMilli) },
      { label: L.strip.bagsReceived, value: qty(pu.receivedQtyMilli) },
      { label: L.strip.lines, value: String(items.length) },
      { label: L.strip.deliveryRef, value: pu.deliveryRef || "—" },
    ],
    columns: L.columns.map((c) => ({ ...c })),
    rows: items.map((it, i) => ({
      sr: i + 1,
      description: it.descriptionEnSnapshot || "",
      descriptionUr: it.descriptionSnapshot && it.descriptionSnapshot !== it.descriptionEnSnapshot ? it.descriptionSnapshot : "",
      brand: it.brandSnapshot || "—",
      pack: it.packageSnapshot || "",
      ordered: qty(it.qtyMilli),
      received: qty(it.receivedQtyMilli),
      orderedQuantity: it.qtyMilli / 1000,
      receivedQuantity: it.receivedQtyMilli / 1000,
      returnedQuantity: it.returnedQtyMilli / 1000,
      godown: whName.get(it.warehouseId) ?? "",
      rateP: it.unitPriceP,
      rate: formatPaisaPlain(it.unitPriceP),
      amountP: it.lineTotalP,
      amount: formatPaisaPlain(it.lineTotalP),
    })),
    itemsFooter: {
      description: `Total — ${items.length} lines`,
      ordered: qty(pu.orderedQtyMilli),
      received: qty(pu.receivedQtyMilli),
      amountP: lineGoodsP,
      amount: formatPaisaPlain(lineGoodsP),
    },
    totals,
    totalP: pu.totalP,
    paidP,
    balanceP: pu.totalP - paidP,
    amountInWords: amountInWords(pu.totalP),
    labels: { words: L.words, payments: L.payments, ribbon: L.ribbonCancelled },
    payments: vouchers.map((v) => ({ paymentId: v.paymentId, receiptNumber: v.receiptNumber, date: v.date, method: v.method, reference: v.reference, amountP: v.allocatedP, text: formatMoney(v.allocatedP) })),
    notes: pu.notes || "",
    signatures: [...L.signatures],
    footer: { thanks: L.thanks },
  };
}
