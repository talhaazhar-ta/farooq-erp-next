import type { Backup } from "@farooq/import";
import { allocateCharges, weightedAverage, type AverageLine } from "@farooq/shared";
import { buildSyntheticInvoices } from "./synthetic-invoices.js";

/**
 * A DETERMINISTIC synthetic legacy backup for the purchase list (S13): S8's 300-invoice backup (14 products in both scripts with
 * categories, two godowns) plus ~160 purchases WITH LINES — 1-3 lines each into either godown, fractional bags, paisa rates, line
 * discounts and tax, overall discounts, freight / loading / other charges, part deliveries (half the bags arrived), orders (nothing
 * arrived), cancelled purchases (bags in and back out), supplier bill numbers, vehicles, drivers and notes in both scripts, a supplier
 * RENAMED since its bills were printed, and supplier vouchers (PV) paying some bills in whole or in part — a few reversed. The stock
 * those deliveries moved, the cost columns (`allocateCharges`) and every stock row's average (`weightedAverage`, LANDED) are worked out
 * here, so the importer's whole reconciliation runs on it and must be 0. All values are invented; the same data every run.
 * The four header-only purchases of the fixture stay (their lines point at products this backup replaced).
 */

type Doc = Record<string, any>;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BILLS = ["SB-4471", "SB 9120", "INV/77-21", "بل 45", "M-2026-118", "ch-889"];
const VEHICLES = ["LES-4471", "LHR 2231", "مری 55", "FSD-908", "TKR 7070"];
const DRIVERS = ["Aslam", "Bashir", "نواز", "Zafar", "Rafiq"];
const NOTES = ["unloaded at night", "دو بوری پھٹی ہوئی", "mill will send the rest tomorrow", "کرایہ ہم نے دیا", "rate agreed on phone"];
const DESCRIPTIONS = ["Eid stock", "ہفتہ وار خریداری", "sample load"];
const METHODS = ["Cash", "Bank Transfer", "Cheque"];

export interface SyntheticPurchaseOptions {
  seed?: number;
  purchases?: number;
}

export function buildSyntheticPurchases(opts: SyntheticPurchaseOptions = {}): Backup {
  const rand = mulberry32(opts.seed ?? 20261013);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const dateOf = (dayOfYear: number) => {
    const d = new Date(Date.UTC(2026, 0, 1 + dayOfYear));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const stamp = (date: string, seconds: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + seconds * 1000).toISOString();

  const base = buildSyntheticInvoices();
  const data = base.data as Record<string, Doc[]>;
  const products = data.products!;
  const warehouses = data.warehouses!;
  const suppliers = data.suppliers!;
  const whName = new Map(warehouses.map((w) => [w.id, w.name as string]));

  // a supplier renamed since its bills were printed: the bills keep the old name
  const renamed = suppliers[2]!;
  const oldName = renamed.co as string;
  renamed.co = "Umar Agro Industries (Pvt) Ltd";

  const pvMax = Math.max(0, ...data.payments!.filter((p) => /^PV-2026-/.test(p.receiptNumber)).map((p) => Number(p.receiptNumber.slice(-6))));
  const counters = { PUR: Math.max(0, ...data.purchases!.map((p) => Number(String(p.purchaseNumber).slice(-6)) || 0)), PV: pvMax };

  const purchases: Doc[] = [];
  const items: Doc[] = [];
  const payments: Doc[] = [];
  const allocations: Doc[] = [];
  const moves: Doc[] = [];
  const n = opts.purchases ?? 160;

  for (let i = 0; i < n; i++) {
    const sup = pick(suppliers);
    const day = int(0, 262);
    const date = dateOf(day);
    const createdAt = stamp(date, 3600 + (i + 1) * 37);
    const id = `spur-${i + 1}`;
    const number = `PUR-2026-${pad(++counters.PUR, 6)}`;
    const cancelled = rand() < 0.06;
    const mode = cancelled ? "all" : rand() < 0.7 ? "all" : rand() < 0.6 ? "part" : "none";

    const nLines = int(1, 3);
    const specs = Array.from({ length: nLines }, () => {
      const p = pick(products);
      const wh = pick(warehouses).id as string;
      const qty = int(5, 150) + (rand() < 0.2 ? 0.5 : 0);
      const unit = int(1500, 9000) * 100 + (rand() < 0.2 ? int(1, 49) * 2 : 0);
      const gross = Math.round(qty * unit);
      const disc = rand() < 0.2 ? int(1, Math.floor(gross / 1000)) * 100 : 0;
      const tax = rand() < 0.1 ? int(1, 500) * 100 : 0;
      const received = mode === "all" ? undefined : mode === "none" ? 0 : Math.floor(qty / 2);
      return { p, wh, qty, unit, gross, disc, tax, received, lineTotal: gross - disc + tax };
    });
    const subtotal = specs.reduce((a, l) => a + l.gross, 0);
    const itemDiscounts = specs.reduce((a, l) => a + l.disc, 0);
    const taxAmount = specs.reduce((a, l) => a + l.tax, 0);
    const overall = rand() < 0.15 ? int(1, 50) * 1000 : 0;
    const freightAmount = rand() < 0.3 ? int(10, 500) * 1000 : 0;
    const loadingAmount = rand() < 0.2 ? int(10, 200) * 1000 : 0;
    const otherCharges = rand() < 0.1 ? int(1, 50) * 1000 : 0;
    const grandTotal = subtotal - itemDiscounts - overall + taxAmount + freightAmount + loadingAmount + otherCharges;
    const orderedQty = specs.reduce((a, l) => a + l.qty, 0);
    const receivedQty = specs.reduce((a, l) => a + (l.received ?? l.qty), 0);

    const alloc = allocateCharges(
      specs.map((l) => ({ qtyMilli: Math.round(l.qty * 1000), receivedQtyMilli: Math.round((l.received ?? l.qty) * 1000), unitPriceP: l.unit, lineTotalP: l.lineTotal })),
      freightAmount + loadingAmount + otherCharges,
    );
    specs.forEach((l, k) => {
      const doc: Doc = {
        id: `spi-${i + 1}-${k + 1}`, purchaseId: id, sortOrder: k, productId: l.p.id, descriptionSnapshot: l.p.ur, descriptionEnSnapshot: l.p.en,
        brandSnapshot: l.p.brandEn, packageSnapshot: `${l.p.kg} KG`, quantity: l.qty, orderedQty: l.qty, receivedQty: l.received, unit: "Bag", unitPrice: l.unit,
        discount: l.disc, tax: l.tax, lineTotal: l.lineTotal, warehouseId: l.wh, batchNo: "", returnedQty: 0, notes: "",
        goodsUnitCost: alloc[k]!.goodsUnitP, chargeShare: alloc[k]!.chargeShareP, landedUnitCost: alloc[k]!.landedUnitP,
      };
      if (l.received === undefined) delete doc.receivedQty;
      items.push(doc);
      const got = l.received ?? l.qty;
      if (got > 0) {
        moves.push({ date, createdAt: stamp(date, 3600 + (i + 1) * 37 + 1 + k), productId: l.p.id, warehouseId: l.wh, kind: "PURCHASE_IN", qtyDelta: got, bucket: "stock", ref: number, refType: "PURCHASE", note: sup.co, unitCostP: l.unit, userId: "Fixture" });
        if (cancelled) {
          moves.push({ date, createdAt: stamp(date, 3600 + (i + 1) * 37 + 20 + k), productId: l.p.id, warehouseId: l.wh, kind: "PURCHASE_REVERSAL_OUT", qtyDelta: -got, bucket: "stock", ref: number, refType: "PURCHASE_EDIT", note: "Reversed on purchase cancel", unitCostP: 0, userId: "Fixture" });
        }
      }
    });

    const header: Doc = {
      id, purchaseNumber: number, clientOpId: `op-${id}`, supplierId: sup.id, supplierNameSnapshot: sup === renamed ? oldName : sup.co,
      supplierInvoiceNo: rand() < 0.6 ? pick(BILLS) : "", warehouseId: specs[0]!.wh, warehouseSnapshot: whName.get(specs[0]!.wh), purchaseDate: date,
      vehicleNo: rand() < 0.5 ? pick(VEHICLES) : "", driver: rand() < 0.4 ? pick(DRIVERS) : "", deliveryRef: rand() < 0.2 ? `DR-${int(10, 99)}` : "",
      subtotal, discountAmount: itemDiscounts + overall, taxAmount, freightAmount, loadingAmount, otherCharges, grandTotal, paidAmount: 0, balanceAmount: grandTotal,
      paymentStatus: "UNPAID", status: cancelled ? "CANCELLED" : receivedQty === 0 ? "ORDERED" : receivedQty < orderedQty ? "PARTIALLY_RECEIVED" : "RECEIVED",
      notes: rand() < 0.3 ? pick(NOTES) : "", description: rand() < 0.1 ? pick(DESCRIPTIONS) : "", totalQty: orderedQty, lineCount: nLines,
      createdBy: "Fixture", createdAt, updatedAt: createdAt, stockApplied: !cancelled && receivedQty > 0, orderedQty, receivedQty, revision: 1,
    };
    purchases.push(header);

    // ── supplier vouchers against the bill: whole or part, some reversed
    if (!cancelled && rand() < 0.45) {
      const whole = rand() < 0.5;
      const amount = whole ? grandTotal : Math.max(100, Math.round((grandTotal * int(20, 80)) / 100 / 100) * 100);
      const reversed = rand() < 0.1;
      const payDay = dateOf(Math.min(262, day + int(0, 15)));
      const pid = `spv-${payments.length + 1}`;
      const p: Doc = {
        id: pid, receiptNumber: `PV-2026-${pad(++counters.PV, 6)}`, direction: "OUT", partyId: sup.id, partyType: "SUPPLIER", isRefund: false,
        partyNameSnapshot: sup.co, partyOwnerSnapshot: "", regionSnapshot: "", amount, method: pick(METHODS), reference: rand() < 0.5 ? header.supplierInvoiceNo : "",
        paymentDate: payDay, note: "", receivedBy: "Fixture", status: reversed ? "REVERSED" : "POSTED", createdAt: stamp(payDay, 70_000 + i), createdBy: "Fixture",
        balanceBefore: 0, balanceAfter: 0,
      };
      if (reversed) {
        p.reversedAt = stamp(payDay, 80_000 + i);
        p.reverseReason = "entered twice";
      } else {
        header.paidAmount = amount;
        header.balanceAmount = grandTotal - amount;
        header.paymentStatus = amount >= grandTotal ? "PAID" : "PARTIAL";
      }
      payments.push(p);
      allocations.push({ id: `spa-${allocations.length + 1}`, paymentId: pid, invoiceId: null, purchaseId: id, amount, createdAt: p.createdAt });
    }
  }

  // ── stock: the invoices' movements plus these deliveries, re-run in entry order; averages from the purchase lines (LANDED)
  const earlier = data.stockMovements!.map(({ id: _i, balanceAfter: _b, ...m }) => m);
  const all = [...earlier, ...moves].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const running = new Map<string, number>();
  data.stockMovements = all.map((m, k) => {
    const key = `${m.productId}|${m.warehouseId}|${m.bucket}`;
    const next = (running.get(key) ?? 0) + Math.round(m.qtyDelta * 1000);
    running.set(key, next);
    return { id: `smv-${k + 1}`, ...m, balanceAfter: next / 1000 };
  });
  const live = new Set(purchases.filter((p) => p.status !== "CANCELLED").map((p) => p.id));
  const avgOf = (productId: string, warehouseId: string): number | null => {
    const lines: AverageLine[] = items
      .filter((it) => live.has(it.purchaseId) && it.productId === productId && it.warehouseId === warehouseId)
      .map((it) => ({
        qtyMilli: Math.round(it.quantity * 1000), receivedQtyMilli: Math.round((it.receivedQty ?? it.quantity) * 1000), unitPriceP: it.unitPrice, lineTotalP: it.lineTotal,
        goodsUnitCostP: it.goodsUnitCost, chargeShareP: it.chargeShare, landedUnitCostP: it.landedUnitCost, operationalShareP: null,
      }));
    return weightedAverage(lines, "LANDED");
  };
  data.inventory = [...new Set(all.map((m) => `${m.productId}|${m.warehouseId}`))].map((k) => {
    const [productId, warehouseId] = k.split("|") as [string, string];
    const avg = avgOf(productId, warehouseId) ?? 60_000;
    return { id: k, productId, warehouseId, qty: (running.get(`${k}|stock`) ?? 0) / 1000, damagedQty: (running.get(`${k}|damaged`) ?? 0) / 1000, avgCostP: avg, lastCostP: avg };
  });

  const byEntry = (a: Doc, b: Doc) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  data.purchases = [...data.purchases!, ...purchases];
  data.purchaseItems = items;
  data.payments = [...data.payments!, ...payments].sort(byEntry);
  data.paymentAllocations = [...data.paymentAllocations!, ...allocations].sort(byEntry);
  data.sequences = [
    ...data.sequences!.filter((s) => s.kind !== "PUR" && s.kind !== "PV"),
    { k: "PUR:2026", kind: "PUR", year: 2026, n: counters.PUR, updatedAt: "2026-09-20T09:00:00.000Z" },
    { k: "PV:2026", kind: "PV", year: 2026, n: counters.PV, updatedAt: "2026-09-20T09:00:00.000Z" },
  ];
  const counts: Record<string, number> = {};
  for (const [store, docs] of Object.entries(data)) counts[store] = docs.length;
  (base as Doc).counts = counts;
  return base;
}
