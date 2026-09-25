import type { Backup } from "@farooq/import";
import { buildSyntheticBackup } from "./synthetic-payments.js";

/**
 * A DETERMINISTIC synthetic legacy backup with ~300 invoices WITH LINES — every status (draft, cancelled, dispatched, partly
 * paid, paid, partly returned, confirmed), 1-4 product lines each (English and Urdu names with the letter variants the search
 * folding exists for, brands, packs), item discounts, fixed line tax, invoice discounts and charges, fractional quantities,
 * totals with paisa, two godowns, shops RENAMED since their invoices were made (the invoice keeps the OLD name printed on it),
 * order / dispatch / reference numbers, notes and descriptions in both scripts, receipts (some reversed, their allocations
 * kept) that pay the invoices in whole or in part, credit notes against a few invoices — and the stock those sales moved, so
 * the importer's whole reconciliation (balances, invoice totals, stock, invoice ↔ stock) can be run on it and must be 0.
 * All values are invented. It shares the committed fixture's envelope and its untouched stores. Seeded: the same data every run.
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

// [English name, Urdu name (letter variants on purpose), brand, category, kg]
const PRODUCTS: [string, string, string, string, number][] = [
  ["Zam Zam Atta 20KG", "زم زم آٹا", "Zam Zam", "Flour", 20],
  ["Zam Zam Sella Rice 25KG", "زم زم سیلا چاول", "Zam Zam", "Rice", 25],
  ["Taj Mahal Sella 25KG", "تاج محل سیلا", "Taj Mahal", "Rice", 25],
  ["Al Noor Sugar 50KG", "النور چینی", "Al Noor", "Sugar", 50],
  ["Delta Maida 50KG", "ڈیلٹا میدہ", "Delta", "Flour", 50],
  ["Bismillah Ghee 5KG", "بسم اللہ گھی", "Bismillah", "Ghee", 5],
  ["Karim Dal Chana 25KG", "كريم دال چنا", "Karim", "Pulses", 25],
  ["Hashim Cooking Oil 16L", "ہاشم کوکنگ آئل", "Hashim", "Oil", 16],
  ["Farooq Basmati 10KG", "فاروق باسمتی", "Farooq", "Rice", 10],
  ["Yasir Tea 1KG", "ياسر چائے", "Yasir", "Tea", 1],
  ["Noor Salt 50KG", "نور نمک", "Noor", "Salt", 50],
  ["Sunrise Fine Flour 40KG", "سن رائز باریک آٹا", "Sunrise", "Flour", 40],
  ["Mandi Gram Flour 25KG", "منڈی بیسن", "Mandi", "Flour", 25],
  ["Kiryana Mix Pulses 10KG", "کریانہ دالیں", "Kiryana", "Pulses", 10],
];
const NOTES = ["deliver in the morning", "گاڑی پر لوڈ کریں", "cash on delivery", "part payment agreed", "کچھ رقم بعد میں", "urgent order for eid", "collect cheque tomorrow", "کرایہ خریدار کے ذمہ"];
const DESCRIPTIONS = ["Weekly stock for the shop", "ہفتہ وار مال", "Ramzan special order", "sample bags included"];
const SALESPEOPLE = ["Ali", "Farooq", "احمد", "Zahid", "کریم"];
const METHODS = ["Cash", "Bank Transfer", "Cheque", "JazzCash", "Easypaisa"];
const REFERENCES = ["CHQ-84711", "CHQ 99120", "TRX/7741", "txn 55-102", "JC-30044", "EP 88213", "ref-2026-77", "چیک 4471"];
const ORDER_REFS = ["PO-7781", "PO-7790", "LPO 55-21", "آرڈر 12"];

export interface SyntheticInvoiceOptions {
  seed?: number;
  invoices?: number;
}

export function buildSyntheticInvoices(opts: SyntheticInvoiceOptions = {}): Backup {
  const rand = mulberry32(opts.seed ?? 20260925);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const dateOf = (dayOfYear: number) => {
    const d = new Date(Date.UTC(2026, 0, 1 + dayOfYear));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };

  const base = buildSyntheticBackup({ payments: 0 });
  const data = base.data as Record<string, Doc[]>;
  const customers = data.customers!;
  const regions = data.regions!;
  const warehouses = data.warehouses!;
  const regionById = new Map(regions.map((r) => [r.id, r]));

  // ── products: clones of the fixture's first product, with names in both scripts ──
  const template = data.products![0]!;
  data.products = PRODUCTS.map(([en, ur, brand, cat, kg], i) => ({
    ...structuredClone(template),
    id: `sp-${i + 1}`, ur, en, name: ur, nameEn: en, normalizedName: en.toLowerCase(), brand, brandEn: brand, cat, category: cat, categoryRaw: cat,
    kg, weightKg: kg, sku: `SKU-SP-${i + 1}`, sourceCode: `SP${i + 1}`,
  }));
  const products = data.products;

  // ── shops renamed since their invoices were made keep printing the old name ──
  const printedName = new Map<string, string>();
  for (const c of customers) printedName.set(c.id, /Renamed/.test(c.sh) ? `${pick(["Old", "Former", "Ex"])} ${pick(["Al Noor", "Zam Zam", "Karim", "ہاشم", "زم زم"])} ${c.id}` : c.sh);

  const total = opts.invoices ?? 300;
  const invoices: Doc[] = [];
  const items: Doc[] = [];
  const payments: Doc[] = [];
  const allocations: Doc[] = [];
  const returns: Doc[] = [];
  const moves: Doc[] = [];
  const counters = { INV: 0, REC: 0, CR: 0, DSP: 0, ORD: 0 };
  const stamp = (day: string, n: number) => `${day}T${pad(4 + Math.floor(n / 3600) % 14)}:${pad(Math.floor(n / 60) % 60)}:${pad(n % 60)}.${pad((n * 7) % 1000, 3)}Z`;

  for (let i = 0; i < total; i++) {
    const day = int(0, 262);
    const date = dateOf(day);
    const cust = customers[int(0, customers.length - 1)]!;
    const whId = rand() < 0.75 ? "wh-1" : "wh-2";
    const whName = whId === "wh-1" ? "Main Godown" : "Second Godown";
    const roll = rand();
    let special: "DRAFT" | "CANCELLED" | "DISPATCHED" | "PARTIALLY_RETURNED" | null = null;
    if (roll < 0.08) special = "DRAFT";
    else if (roll < 0.16) special = "CANCELLED";
    else if (roll < 0.24) special = "DISPATCHED";
    else if (roll < 0.28) special = "PARTIALLY_RETURNED";

    // ── lines
    const nLines = int(1, 4);
    const chosen = [...products].sort(() => rand() - 0.5).slice(0, nLines);
    const lines = chosen.map((p) => {
      const half = rand() < 0.22;
      const qty = half ? int(1, 40) + 0.5 : int(1, 60);
      const unit = int(400, 6000) * 100 + (rand() < 0.15 ? 50 : 0);
      const gross = Math.round(unit * qty);
      const disc = rand() < 0.25 ? Math.min(gross, int(1, 20) * 500) : 0;
      const tax = rand() < 0.12 ? int(1, 30) * 100 : 0;
      const wh = rand() < 0.15 ? (whId === "wh-1" ? "wh-2" : "wh-1") : whId;
      return { p, qty, unit, gross, disc, tax, cost: rand() < 0.85 ? Math.round(unit * (0.7 + rand() * 0.2) / 100) * 100 : 0, wh };
    });
    const subtotal = lines.reduce((a, l) => a + l.gross, 0);
    const itemDiscounts = lines.reduce((a, l) => a + l.disc, 0);
    const taxAmount = lines.reduce((a, l) => a + l.tax, 0);
    const invoiceDiscount = rand() < 0.2 ? Math.min(subtotal - itemDiscounts, int(1, 20) * 1000) : 0;
    const freightAmount = rand() < 0.2 ? int(1, 30) * 500 : 0;
    const loadingAmount = rand() < 0.15 ? int(1, 10) * 500 : 0;
    const otherCharges = rand() < 0.1 ? int(1, 10) * 250 : 0;
    const grandTotal = subtotal - itemDiscounts - invoiceDiscount + taxAmount + freightAmount + loadingAmount + otherCharges;

    const id = `sinv-${i + 1}`;
    const number = special === "DRAFT" ? "" : `INV-2026-${pad(++counters.INV, 6)}`;
    const createdAt = stamp(date, i);

    // ── receipts: decided first, so the stored status follows what is really paid (the legacy `refreshPaymentState`)
    const plan: { amount: number; reversed: boolean }[] = [];
    if (special !== "DRAFT" && special !== "CANCELLED" && rand() < 0.62) {
      const full = rand() < 0.45;
      const first = full ? grandTotal : Math.max(1, Math.floor((grandTotal * (0.2 + rand() * 0.6)) / 50) * 50);
      if (full && rand() < 0.3 && grandTotal > 2000) {
        const a = Math.floor(grandTotal / 2);
        plan.push({ amount: a, reversed: rand() < 0.12 }, { amount: grandTotal - a, reversed: rand() < 0.12 });
      } else plan.push({ amount: first, reversed: rand() < 0.12 });
    }
    const paid = plan.filter((x) => !x.reversed).reduce((a, x) => a + x.amount, 0);
    const paymentStatus = grandTotal <= 0 ? "UNPAID" : paid >= grandTotal ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";
    const status = special ?? (paymentStatus === "PAID" ? "PAID" : paymentStatus === "PARTIAL" ? "PARTIALLY_PAID" : "CONFIRMED");

    const returnedBag = special === "PARTIALLY_RETURNED" ? 1 : 0;
    lines.forEach((l, k) => {
      items.push({
        id: `sii-${i + 1}-${k + 1}`, invoiceId: id, sortOrder: k, productId: l.p.id, productVariantId: null,
        descriptionSnapshot: l.p.ur, descriptionEnSnapshot: l.p.en, brandSnapshot: l.p.brand, categorySnapshot: l.p.cat,
        packageSnapshot: `${l.p.kg} KG`, skuSnapshot: l.p.sku, unit: "Bag", quantity: l.qty, unitPrice: l.unit, discount: l.disc, tax: l.tax,
        lineTotal: l.gross - l.disc + l.tax, costSnapshot: l.cost, warehouseId: l.wh, batchNo: "", notes: "", returnedQty: k === 0 ? returnedBag : 0,
      });
    });

    const reg = regionById.get(cust.region)!;
    const isDraft = special === "DRAFT";
    invoices.push({
      id, invoiceNumber: number, clientOpId: `op-${id}`, invoiceType: "SALE", saleOrderId: null,
      orderNumber: rand() < 0.2 ? `ORD-2026-${pad(++counters.ORD, 6)}` : "",
      dispatchNumber: special === "DISPATCHED" ? `DSP-2026-${pad(++counters.DSP, 6)}` : "",
      customerId: cust.id, customerCodeSnapshot: cust.legacyCode, customerNameSnapshot: cust.ow, shopNameSnapshot: printedName.get(cust.id),
      contactPersonSnapshot: cust.ow, mobileSnapshot: cust.ph, whatsappSnapshot: cust.wa, addressSnapshot: "", regionId: cust.region,
      regionSnapshot: `${reg.ur} — ${reg.en}`, marketSnapshot: "", warehouseId: whId, warehouseSnapshot: whName, salesperson: rand() < 0.6 ? pick(SALESPEOPLE) : "",
      invoiceDate: date, dueDate: dateOf(day + int(0, 30)), subtotal, discountAmount: itemDiscounts + invoiceDiscount, itemDiscounts, invoiceDiscount,
      taxAmount, freightAmount, loadingAmount, otherCharges, grandTotal, paidAmount: paid, balanceAmount: grandTotal - paid, paymentStatus,
      paymentMethod: rand() < 0.3 ? pick(METHODS) : "", referenceNo: rand() < 0.15 ? pick(ORDER_REFS) : "", status,
      notes: rand() < 0.35 ? pick(NOTES) : "", description: rand() < 0.2 ? pick(DESCRIPTIONS) : "",
      totalQty: lines.reduce((a, l) => a + l.qty, 0), lineCount: lines.length, previousBalance: int(0, 400) * 1000, revision: isDraft ? 0 : 1, createdBy: "Fixture",
      createdAt, updatedAt: createdAt, confirmedAt: isDraft ? null : createdAt, cancelledAt: special === "CANCELLED" ? stamp(date, i + 5000) : null,
      cancelReason: special === "CANCELLED" ? "customer changed his mind" : "", stockApplied: !isDraft && special !== "CANCELLED",
    });

    // ── receipts and their allocations
    plan.forEach((pl, k) => {
      const payDay = dateOf(Math.min(262, day + int(0, 20)));
      const pid = `spay-${payments.length + 1}`;
      const receiptNumber = `REC-2026-${pad(++counters.REC, 6)}`;
      const p: Doc = {
        id: pid, receiptNumber, direction: "IN", partyId: cust.id, partyType: "CUSTOMER", isRefund: false, partyNameSnapshot: printedName.get(cust.id),
        partyOwnerSnapshot: cust.ow, regionSnapshot: `${reg.ur} — ${reg.en}`, amount: pl.amount, method: pick(METHODS), reference: rand() < 0.6 ? pick(REFERENCES) : "",
        paymentDate: payDay, note: "", receivedBy: "Fixture", status: pl.reversed ? "REVERSED" : "POSTED", createdAt: stamp(payDay, 10_000 + payments.length),
        createdBy: "Fixture", balanceBefore: 0, balanceAfter: 0,
      };
      if (pl.reversed) {
        p.reversedAt = stamp(payDay, 20_000 + payments.length);
        p.reverseReason = "cheque bounced";
      }
      payments.push(p);
      allocations.push({ id: `sal-${allocations.length + 1}`, paymentId: pid, invoiceId: id, purchaseId: null, amount: pl.amount, createdAt: p.createdAt });
      void k;
    });

    // ── a credit note against a partly returned invoice (the bag came back damaged)
    if (special === "PARTIALLY_RETURNED") {
      const crNo = `CR-2026-${pad(++counters.CR, 6)}`;
      const line = lines[0]!;
      const retDay = dateOf(Math.min(262, day + 3));
      returns.push({
        id: `scr-${returns.length + 1}`, returnNumber: crNo, clientOpId: `op-scr-${returns.length + 1}`, invoiceId: id, invoiceNumber: number, customerId: cust.id,
        customerNameSnapshot: "", regionSnapshot: "", warehouseId: whId, warehouseSnapshot: whName, returnDate: retDay, reason: "", treatment: "ADJUST_OUTSTANDING_BALANCE",
        condition: "", notes: "", description: "", creditAmount: line.unit, replacementValue: 0, totalQty: 1, lineCount: 1, status: "POSTED", createdBy: "Fixture", createdAt: stamp(retDay, 3000 + i),
      });
      moves.push({ date: retDay, createdAt: stamp(retDay, 3000 + i), productId: line.p.id, warehouseId: line.wh, kind: "CUSTOMER_RETURN_DAMAGED_IN", qtyDelta: 1, bucket: "damaged", ref: crNo, refType: "CUSTOMER_RETURN", note: `Return ${crNo}`, unitCostP: 0, userId: "Fixture" });
    }

    // ── the stock this invoice moved (drafts move none; a cancelled invoice's bags came back)
    if (!isDraft) {
      lines.forEach((l, k) => {
        moves.push({ date, createdAt: stamp(date, i + 100 + k), productId: l.p.id, warehouseId: l.wh, kind: "SALE_OUT", qtyDelta: -l.qty, bucket: "stock", ref: number, refType: "INVOICE", note: printedName.get(cust.id), unitCostP: 0, userId: "Fixture" });
        if (special === "CANCELLED") {
          moves.push({ date: dateOf(day + 1), createdAt: stamp(dateOf(day + 1), i + 200 + k), productId: l.p.id, warehouseId: l.wh, kind: "SALE_REVERSAL_IN", qtyDelta: l.qty, bucket: "stock", ref: number, refType: "INVOICE_CANCEL", note: "Invoice cancelled — customer changed his mind", unitCostP: 0, userId: "Fixture" });
        }
      });
    }
  }

  // ── opening stock (plenty), then the running balances and the final inventory rows, worked out from the movements
  const opening: Doc[] = [];
  let rcv = 0;
  for (const p of products) for (const w of warehouses) {
    opening.push({ date: "2025-12-31", createdAt: `2025-12-31T09:00:${pad(rcv % 60)}.000Z`, productId: p.id, warehouseId: w.id, kind: "OPENING_STOCK", qtyDelta: 100_000, bucket: "stock", ref: `RCV-2025-${pad(++rcv, 6)}`, refType: "STOCK_RECEIPT", note: "", unitCostP: 60_000, userId: "Fixture" });
  }
  const all = [...opening, ...moves].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const running = new Map<string, number>();
  const stockMovements = all.map((m, n) => {
    const key = `${m.productId}|${m.warehouseId}|${m.bucket}`;
    const next = (running.get(key) ?? 0) + Math.round(m.qtyDelta * 1000);
    running.set(key, next);
    return { id: `smv-${n + 1}`, ...m, balanceAfter: next / 1000 };
  });
  const inventory = [...new Set(all.map((m) => `${m.productId}|${m.warehouseId}`))].map((k) => {
    const [productId, warehouseId] = k.split("|") as [string, string];
    return { id: k, productId, warehouseId, qty: (running.get(`${k}|stock`) ?? 0) / 1000, damagedQty: (running.get(`${k}|damaged`) ?? 0) / 1000, avgCostP: 60_000, lastCostP: 60_000 };
  });

  // a legacy store is in the order things were entered: receipts (and their allocations) by the moment they were made
  const byEntry = (a: Doc, b: Doc) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  data.invoices = invoices;
  data.invoiceItems = items;
  data.payments = payments.sort(byEntry);
  data.paymentAllocations = allocations.sort(byEntry);
  data.customerReturns = returns;
  data.stockMovements = stockMovements;
  data.inventory = inventory;
  // the fixture's purchase lines and landed-cost rows point at the fixture's products, which this backup replaces: its purchases are header-only (listed as "no lines" by the reconciliation)
  data.purchaseItems = [];
  data.landedCosts = [];
  data.landedCostExpenses = [];
  data.inventoryCostAdjust = [];
  data.sequences = [
    { k: "INV:2026", kind: "INV", year: 2026, n: counters.INV, updatedAt: "2026-09-20T09:00:00.000Z" },
    { k: "REC:2026", kind: "REC", year: 2026, n: counters.REC, updatedAt: "2026-09-20T09:00:00.000Z" },
    { k: "CR:2026", kind: "CR", year: 2026, n: counters.CR, updatedAt: "2026-09-20T09:00:00.000Z" },
  ];

  const counts: Record<string, number> = {};
  for (const [store, docs] of Object.entries(data)) counts[store] = docs.length;
  (base as Doc).counts = counts;
  return base;
}
