import type { Backup } from "@farooq/import";
// The deterministic synthetic backups the API's S4 (payments) and S8 (invoices with lines) parity tests use (seeded; invented values only).
import { buildSyntheticBackup } from "../../api/test/helpers/synthetic-payments";
import { buildSyntheticInvoices } from "../../api/test/helpers/synthetic-invoices";

/**
 * The e2e dataset =
 *   - S8's seeded synthetic backup: 300 invoices WITH LINES, every status (draft, confirmed, partly paid, paid, cancelled,
 *     dispatched, partly returned), receipts (some reversed), credit notes, two godowns and the stock they moved;
 *   - S4's 300 payments (paging, search, facets, supplier payments, refunds, reversals) — re-numbered so the receipt numbers do
 *     not collide with the invoice receipts, and the ones that paid S4's own (lineless) invoices re-pointed at S8's invoices
 *     of the same shop, within what each still owes;
 *   - a few hand-made shops with known invoices, so the tests can assert exact figures (unchanged since S5).
 * All names and amounts are invented. Money is integer paisa.
 *
 *   Alpha   three unpaid invoices  Rs 10,000 / 20,000 / 30,000   (oldest first: auto-allocation)
 *   Beta    two unpaid invoices    Rs  5,000 /  5,000            (manual allocation)
 *   Gamma   one unpaid invoice     Rs  8,000, an Urdu shop name  (Urdu names on every screen)
 *   Delta / Echo / Foxtrot / Golf / Hotel / India / Juliet   shops with no invoices        (each test that changes money uses its own shop)
 *   Kilo / Lima / Mike / November / Oscar   the same, for the invoice specs (S9)
 *   Papa … Zulu (eleven shops)   the same, for the invoice BUILDER specs (S10)
 *   five builder products (BUILDER_PRODUCTS): one with a set price and a minimum, one carried only by its last invoiced rate
 *   (the spec posts that invoice), one whose set price is below what it cost, one with no bags in the second godown, one with
 *   10 bags in each godown (shortage tests)
 */
export const SCENARIO = {
  alpha: { id: "e2e-cust-alpha", name: "E2E Alpha Store", invoices: [1_000_000, 2_000_000, 3_000_000] },
  beta: { id: "e2e-cust-beta", name: "E2E Beta Traders", invoices: [500_000, 500_000] },
  gamma: { id: "e2e-cust-gamma", name: "گاما ٹریڈرز E2E", invoices: [800_000] },
  delta: { id: "e2e-cust-delta", name: "E2E Delta Shop", invoices: [] },
  echo: { id: "e2e-cust-echo", name: "E2E Echo Shop", invoices: [] },
  foxtrot: { id: "e2e-cust-foxtrot", name: "E2E Foxtrot Shop", invoices: [] },
  golf: { id: "e2e-cust-golf", name: "E2E Golf Shop", invoices: [] },
  hotel: { id: "e2e-cust-hotel", name: "E2E Hotel Shop", invoices: [] },
  india: { id: "e2e-cust-india", name: "E2E India Shop", invoices: [] },
  juliet: { id: "e2e-cust-juliet", name: "E2E Juliet Shop", invoices: [] },
  // S9: shops the invoice specs post to / move between (each money-moving invoice test owns one, like S5's)
  kilo: { id: "e2e-cust-kilo", name: "E2E Kilo Shop", invoices: [] },
  lima: { id: "e2e-cust-lima", name: "E2E Lima Shop", invoices: [] },
  mike: { id: "e2e-cust-mike", name: "E2E Mike Shop", invoices: [] },
  november: { id: "e2e-cust-november", name: "E2E November Shop", invoices: [] },
  oscar: { id: "e2e-cust-oscar", name: "E2E Oscar Shop", invoices: [] },
  // S10: shops the builder specs create invoices for
  papa: { id: "e2e-cust-papa", name: "E2E Papa Shop", invoices: [] },
  quebec: { id: "e2e-cust-quebec", name: "E2E Quebec Shop", invoices: [] },
  romeo: { id: "e2e-cust-romeo", name: "E2E Romeo Shop", invoices: [] },
  sierra: { id: "e2e-cust-sierra", name: "E2E Sierra Shop", invoices: [] },
  tango: { id: "e2e-cust-tango", name: "E2E Tango Shop", invoices: [] },
  uniform: { id: "e2e-cust-uniform", name: "E2E Uniform Shop", invoices: [] },
  victor: { id: "e2e-cust-victor", name: "E2E Victor Shop", invoices: [] },
  whiskey: { id: "e2e-cust-whiskey", name: "E2E Whiskey Shop", invoices: [] },
  xray: { id: "e2e-cust-xray", name: "E2E Xray Shop", invoices: [] },
  yankee: { id: "e2e-cust-yankee", name: "E2E Yankee Shop", invoices: [] },
  zulu: { id: "e2e-cust-zulu", name: "E2E Zulu Shop", invoices: [] },
  supplier: { id: "e2e-sup-mills", name: "E2E Supplier Mills", purchases: [5_000_000] },
  // S13: suppliers the purchase specs create their bills for (each money-moving spec owns one); the last has an Urdu name
  supKarachi: { id: "e2e-sup-karachi", name: "E2E Karachi Flour Mills", purchases: [] },
  supLahore: { id: "e2e-sup-lahore", name: "E2E Lahore Grain Co", purchases: [] },
  supMultan: { id: "e2e-sup-multan", name: "E2E Multan Rice Traders", purchases: [] },
  supQuetta: { id: "e2e-sup-quetta", name: "کوئٹہ ملز E2E", purchases: [] },
  // S15: suppliers the purchase-BUILDER specs record bills for (each money-moving test owns one; the last has an Urdu name)
  supSahiwal: { id: "e2e-sup-sahiwal", name: "E2E Sahiwal Grain Mills", purchases: [] },
  supFaisal: { id: "e2e-sup-faisal", name: "E2E Faisalabad Feed Co", purchases: [] },
  supSukkur: { id: "e2e-sup-sukkur", name: "E2E Sukkur Rice Traders", purchases: [] },
  supBahawal: { id: "e2e-sup-bahawal", name: "E2E Bahawalpur Oils", purchases: [] },
  supGujrat: { id: "e2e-sup-gujrat", name: "E2E Gujrat Atta Works", purchases: [] },
  supSialkot: { id: "e2e-sup-sialkot", name: "سیالکوٹ ملز E2E", purchases: [] },
  supJhelum: { id: "e2e-sup-jhelum", name: "E2E Jhelum Bulk Supply", purchases: [] },
  supMardan: { id: "e2e-sup-mardan", name: "E2E Mardan Wheat Depot", purchases: [] },
  supKasur: { id: "e2e-sup-kasur", name: "E2E Kasur Salt Works", purchases: [] },
  supDera: { id: "e2e-sup-dera", name: "E2E Dera Ismail Stores", purchases: [] },
  supSwat: { id: "e2e-sup-swat", name: "E2E Swat Valley Supply", purchases: [] },
  // a shop the builder spec sells one bought product to (a purchase cannot be cut below the bags already sold)
  buyerShop: { id: "e2e-cust-buyer", name: "E2E Buyer Shop", invoices: [] },
} as const;

/**
 * S13: products that only the purchase specs buy (a purchase moves stock and rewrites the average cost, so the builder products stay out
 * of it). `cat` is the category the list filters by.
 */
export const PURCHASE_PRODUCTS = {
  wheat: { id: "pp-wheat", en: "E2E Purchase Wheat 40KG", ur: "ای ٹو ای گندم", cat: "گندم", kg: 40 },
  maida: { id: "pp-maida", en: "E2E Purchase Maida 50KG", ur: "ای ٹو ای میدہ", cat: "آٹا", kg: 50 },
  bran: { id: "pp-bran", en: "E2E Purchase Bran 30KG", ur: "ای ٹو ای چوکر", cat: "چوکر", kg: 30 },
} as const;

/**
 * S15: products that only the purchase-BUILDER specs buy (a purchase moves stock and rewrites the average cost). No "Builder" in the name —
 * S10's product search counts the "builder" ones — and no Urdu word S10 searches for.
 */
export const BUYER_PRODUCTS = {
  rice: { id: "by-rice", en: "E2E Buyer Rice 25KG", ur: "خریدار اناج", cat: "خریدار اناج", kg: 25 },
  sugar: { id: "by-sugar", en: "E2E Buyer Sugar 50KG", ur: "خریدار شکر", cat: "خریدار شکر", kg: 50 },
  salt: { id: "by-salt", en: "E2E Buyer Salt 5KG", ur: "خریدار نمک", cat: "خریدار نمک", kg: 5 },
  ghee: { id: "by-ghee", en: "E2E Buyer Ghee 10KG", ur: "خریدار گھی", cat: "خریدار گھی", kg: 10 },
} as const;

type Doc = Record<string, any>;

/** The S10 builder products (invented). `bags` = bags in each godown, in order; cost = what they were received at (paisa per bag). */
export const BUILDER_PRODUCTS = {
  priced: { id: "bp-priced", en: "Builder Priced Rice 25KG", ur: "قیمت والا چاول", sellP: 200_000, minSellP: 180_000, costP: 150_000, bags: [500, 500] },
  lastRate: { id: "bp-lastrate", en: "Builder LastRate Flour 10KG", ur: "آخری ریٹ آٹا", sellP: null, minSellP: null, costP: 90_000, bags: [500, 500] },
  belowCost: { id: "bp-belowcost", en: "Builder BelowCost Sugar 50KG", ur: "کم قیمت چینی", sellP: 50_000, minSellP: 45_000, costP: 90_000, bags: [500, 500] },
  zero: { id: "bp-zero", en: "Builder ZeroStock Salt 5KG", ur: "خالی نمک", sellP: 100_000, minSellP: null, costP: 60_000, bags: [40, 0] },
  tight: { id: "bp-tight", en: "Builder Tight Pulses 20KG", ur: "تنگ دالیں", sellP: 100_000, minSellP: null, costP: 60_000, bags: [10, 10] },
} as const;

function addBuilderProducts(data: Record<string, Doc[]>): void {
  const template = data.products![0]!;
  const warehouses = data.warehouses!;
  const pad = (n: number) => String(n).padStart(6, "0");
  let n = 0;
  const running = new Map<string, number>();
  for (const b of Object.values(BUILDER_PRODUCTS)) {
    const product: Doc = {
      ...structuredClone(template),
      id: b.id, ur: b.ur, en: b.en, name: b.ur, nameEn: b.en, normalizedName: b.en.toLowerCase(), brand: "Builder", brandEn: "Builder", cat: "Builder", category: "Builder", categoryRaw: "Builder",
      kg: 25, weightKg: 25, sku: `SKU-${b.id}`, sourceCode: b.id, taxPct: 0, buyP: b.costP, sellP: b.sellP, minSellP: b.minSellP, sell: 0, min: 0, buy: 0, extra: 0, extraP: 0, wholesaleP: 0, retailP: 0,
    };
    if (b.sellP === null) {
      // "no price set": the importer reads a null / missing `sellP` and a falsy legacy `sell` as never set
      delete product.sellP;
      delete product.minSellP;
      delete product.buyP;
    }
    data.products!.push(product);
    b.bags.forEach((bags, i) => {
      if (bags === 0) return;
      const wh = warehouses[i]!;
      const key = `${b.id}|${wh.id}|stock`;
      running.set(key, bags);
      data.stockMovements!.push({
        id: `bp-smv-${++n}`, createdAt: `2025-12-30T10:00:${String(n).padStart(2, "0")}.000Z`, date: "2025-12-30", productId: b.id, warehouseId: wh.id, kind: "OPENING_STOCK", qtyDelta: bags, bucket: "stock",
        balanceAfter: bags, ref: `RCV-2025-${pad(900 + n)}`, refType: "STOCK_RECEIPT", note: "", unitCostP: b.costP, userId: "Fixture",
      });
      data.inventory!.push({ id: `${b.id}|${wh.id}`, productId: b.id, warehouseId: wh.id, qty: bags, damagedQty: 0, avgCostP: b.costP, lastCostP: b.costP });
    });
  }
}

/** S13's purchase products: in the catalogue, no bags yet (except the wheat the dataset's own purchase brought, added below). */
function addPurchaseProducts(data: Record<string, Doc[]>): void {
  const template = data.products![0]!;
  for (const p of [...Object.values(PURCHASE_PRODUCTS), ...Object.values(BUYER_PRODUCTS)]) {
    data.products!.push({
      ...structuredClone(template),
      id: p.id, ur: p.ur, en: p.en, name: p.ur, nameEn: p.en, normalizedName: p.en.toLowerCase(), brand: "E2E", brandEn: "E2E", cat: p.cat, category: p.cat, categoryRaw: p.cat,
      kg: p.kg, weightKg: p.kg, sku: `SKU-${p.id}`, sourceCode: p.id,
    });
  }
}

/** S8's invoices + S4's payments in one backup (see the header). Every shop's balance is still worked out from the same documents on both sides of the reconciliation. */
function mergedBase(): Backup {
  const backup = buildSyntheticInvoices();
  const data = backup.data as Record<string, Doc[]>;
  const s4 = buildSyntheticBackup({ payments: 300 }).data as Record<string, Doc[]>;
  const pad = (n: number) => String(n).padStart(6, "0");
  const seq = (kind: string) => (data.sequences!.find((x) => x.kind === kind)?.n as number | undefined) ?? 0;

  // receipts: S4's shop receipts continue the REC series after S8's; its payment vouchers (PV) are new to this dataset
  let rec = seq("REC");
  let pv = 0;
  const byOriginal = [...s4.payments!].sort((a, b) => (a.receiptNumber < b.receiptNumber ? -1 : 1));
  const renamed = new Map<string, string>();
  for (const p of byOriginal) renamed.set(p.id, p.direction === "IN" ? `REC-2026-${pad(++rec)}` : `PV-2026-${pad(++pv)}`);
  const payments: Doc[] = s4.payments!.map((p) => ({ ...p, receiptNumber: renamed.get(p.id)! }));
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  // what each S8 invoice still owes after the receipts already on it (only POSTED receipts count)
  const owed = new Map<string, number>();
  const collectable = new Map<string, Doc[]>();
  for (const inv of data.invoices!) {
    if (inv.status === "DRAFT" || inv.status === "CANCELLED") continue;
    owed.set(inv.id, inv.grandTotal);
    (collectable.get(inv.customerId) ?? collectable.set(inv.customerId, []).get(inv.customerId)!).push(inv);
  }
  const posted = new Set(data.payments!.filter((p) => p.status === "POSTED").map((p) => p.id));
  for (const a of data.paymentAllocations!) if (a.invoiceId && posted.has(a.paymentId)) owed.set(a.invoiceId, (owed.get(a.invoiceId) ?? 0) - a.amount);

  const allocations = s4.paymentAllocations!.flatMap((a) => {
    if (!a.invoiceId) return [{ ...a, id: `s4-${a.id}` }]; // supplier payment → purchase: unchanged
    const pay = paymentById.get(a.paymentId)!;
    const invs = collectable.get(pay.partyId) ?? [];
    const inv = invs.find((i) => (owed.get(i.id) ?? 0) > 0);
    if (!inv) return []; // this shop has nothing left to collect: the receipt stays on account
    const take = Math.min(a.amount, owed.get(inv.id)!);
    if (pay.status === "POSTED") owed.set(inv.id, owed.get(inv.id)! - take);
    return [{ ...a, id: `s4-${a.id}`, invoiceId: inv.id, amount: take }];
  });

  const byEntry = (a: Doc, b: Doc) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  data.payments = [...data.payments!, ...payments].sort(byEntry);
  data.paymentAllocations = [...data.paymentAllocations!, ...allocations].sort(byEntry);
  data.sequences = data.sequences!.filter((x) => x.kind !== "REC").concat([
    { k: "REC:2026", kind: "REC", year: 2026, n: rec, updatedAt: "2026-09-20T09:00:00.000Z" },
    { k: "PV:2026", kind: "PV", year: 2026, n: pv, updatedAt: "2026-09-20T09:00:00.000Z" },
  ]);
  return backup;
}

export function buildE2eBackup(): Backup {
  const backup = mergedBase();
  const data = backup.data as Record<string, Doc[]>;
  const customerTemplate = data.customers![0]!;
  const invoiceTemplate = data.invoices![0]!;
  const purchaseTemplate = data.purchases![0]!;
  const supplierTemplate = data.suppliers![0]!;
  const pad = (n: number) => String(n).padStart(6, "0");
  let invNo = 900_000;

  const shops = [SCENARIO.alpha, SCENARIO.beta, SCENARIO.gamma, SCENARIO.delta, SCENARIO.echo, SCENARIO.foxtrot, SCENARIO.golf, SCENARIO.hotel, SCENARIO.india, SCENARIO.juliet, SCENARIO.kilo, SCENARIO.lima, SCENARIO.mike, SCENARIO.november, SCENARIO.oscar, SCENARIO.papa, SCENARIO.quebec, SCENARIO.romeo, SCENARIO.sierra, SCENARIO.tango, SCENARIO.uniform, SCENARIO.victor, SCENARIO.whiskey, SCENARIO.xray, SCENARIO.yankee, SCENARIO.zulu, SCENARIO.buyerShop];
  shops.forEach((s, i) => {
    data.customers!.push({
      ...customerTemplate,
      id: s.id,
      legacyCode: `E${pad(i + 1)}`,
      sh: s.name,
      ow: `Owner ${i + 1}`,
      nameUr: "",
      ph: `0300-555${String(i + 1).padStart(4, "0")}`,
      wa: "",
      region: "rg-drosh",
      isCashCounter: false,
      active: true,
    });
    s.invoices.forEach((grandTotal, k) => {
      const day = `2026-08-${String(1 + k * 9).padStart(2, "0")}`;
      data.invoices!.push({
        ...invoiceTemplate,
        id: `e2e-inv-${s.id}-${k + 1}`,
        invoiceNumber: `INV-2026-${pad(++invNo)}`,
        clientOpId: `op-e2e-inv-${s.id}-${k + 1}`,
        orderNumber: "",
        dispatchNumber: "",
        customerId: s.id,
        customerCodeSnapshot: `E${pad(i + 1)}`,
        customerNameSnapshot: `Owner ${i + 1}`,
        shopNameSnapshot: s.name,
        contactPersonSnapshot: `Owner ${i + 1}`,
        mobileSnapshot: `0300-555${String(i + 1).padStart(4, "0")}`,
        whatsappSnapshot: "",
        regionId: "rg-drosh",
        regionSnapshot: "دروش — Drosh",
        salesperson: "",
        invoiceDate: day,
        dueDate: day,
        subtotal: grandTotal,
        discountAmount: 0,
        itemDiscounts: 0,
        invoiceDiscount: 0,
        taxAmount: 0,
        freightAmount: 0,
        loadingAmount: 0,
        otherCharges: 0,
        grandTotal,
        paidAmount: 0,
        balanceAmount: grandTotal,
        paymentStatus: "UNPAID",
        paymentMethod: "",
        referenceNo: "",
        status: "CONFIRMED",
        notes: "",
        description: "",
        totalQty: 0,
        lineCount: 0,
        previousBalance: 0,
        revision: 1,
        createdAt: `${day}T05:00:00.000Z`,
        updatedAt: `${day}T05:00:00.000Z`,
        confirmedAt: `${day}T05:00:00.000Z`,
        cancelledAt: null,
        cancelReason: "",
        stockApplied: false,
      });
    });
  });

  addBuilderProducts(data);

  data.suppliers!.push({ ...supplierTemplate, id: SCENARIO.supplier.id, legacyCode: "E-S01", co: SCENARIO.supplier.name, cp: "Mr Mills", ph: "0300-7770001", lo: "Peshawar", active: true });
  [SCENARIO.supKarachi, SCENARIO.supLahore, SCENARIO.supMultan, SCENARIO.supQuetta, SCENARIO.supSahiwal, SCENARIO.supFaisal, SCENARIO.supSukkur, SCENARIO.supBahawal, SCENARIO.supGujrat, SCENARIO.supSialkot, SCENARIO.supJhelum, SCENARIO.supMardan, SCENARIO.supKasur, SCENARIO.supDera, SCENARIO.supSwat].forEach((s, i) =>
    data.suppliers!.push({ ...supplierTemplate, id: s.id, legacyCode: `E-S${pad(i + 2)}`, co: s.name, cp: "", ph: `0300-777${String(i + 2).padStart(4, "0")}`, lo: "", active: true }),
  );
  addPurchaseProducts(data);

  // S13: the dataset's purchase now has a line (100 bags of wheat at Rs 500 into the first godown, supplier's bill MILL-77, lorry LES-1234),
  // and a CANCELLED one sits beside it (10 bags in, then out again) — the list, the view page and the print need both
  const wh = data.warehouses![0]!;
  const wheat = PURCHASE_PRODUCTS.wheat;
  const header = (id: string, no: string, date: string, total: number, qty: number, status: string, extra: Doc = {}): Doc => ({
    ...purchaseTemplate,
    id, purchaseNumber: no, supplierId: SCENARIO.supplier.id, supplierNameSnapshot: SCENARIO.supplier.name, supplierInvoiceNo: "MILL-77", warehouseId: wh.id,
    warehouseSnapshot: wh.name, purchaseDate: date, vehicleNo: "LES-1234", driver: "Aslam", deliveryRef: "", subtotal: total, discountAmount: 0, taxAmount: 0,
    freightAmount: 0, loadingAmount: 0, otherCharges: 0, grandTotal: total, paidAmount: 0, balanceAmount: total, paymentStatus: "UNPAID", status, notes: "",
    totalQty: qty, orderedQty: qty, receivedQty: qty, lineCount: 1, createdAt: `${date}T06:00:00.000Z`, updatedAt: `${date}T06:00:00.000Z`, stockApplied: status !== "CANCELLED", revision: 1,
    ...extra,
  });
  const line = (id: string, purchaseId: string, qty: number): Doc => ({
    id, purchaseId, sortOrder: 0, productId: wheat.id, descriptionSnapshot: wheat.ur, descriptionEnSnapshot: wheat.en, brandSnapshot: "E2E", packageSnapshot: `${wheat.kg} KG`,
    quantity: qty, orderedQty: qty, receivedQty: qty, unit: "Bag", unitPrice: 50_000, discount: 0, tax: 0, lineTotal: qty * 50_000, warehouseId: wh.id, batchNo: "", returnedQty: 0,
    notes: "", goodsUnitCost: 50_000, chargeShare: 0, landedUnitCost: 50_000,
  });
  const move = (n: number, date: string, time: string, kind: string, delta: number, no: string, refType: string, balance: number): Doc => ({
    id: `pp-smv-${n}`, createdAt: `${date}T${time}.000Z`, date, productId: wheat.id, warehouseId: wh.id, kind, qtyDelta: delta, bucket: "stock", balanceAfter: balance, ref: no, refType,
    note: SCENARIO.supplier.name, unitCostP: delta > 0 ? 50_000 : 0, userId: "Fixture",
  });
  SCENARIO.supplier.purchases.forEach((grandTotal, k) => {
    const no = `PUR-2026-${pad(900_001 + k)}`;
    data.purchases!.push(header(`e2e-pur-${k + 1}`, no, "2026-08-05", grandTotal, grandTotal / 50_000, "RECEIVED"));
    data.purchaseItems!.push(line(`e2e-pi-${k + 1}`, `e2e-pur-${k + 1}`, grandTotal / 50_000));
  });
  data.purchases!.push(header("e2e-pur-cancelled", "PUR-2026-900090", "2026-08-06", 500_000, 10, "CANCELLED", { notes: "wrong mill" }));
  data.purchaseItems!.push(line("e2e-pi-cancelled", "e2e-pur-cancelled", 10));
  data.stockMovements!.push(
    move(1, "2026-08-05", "06:00:10", "PURCHASE_IN", 100, "PUR-2026-900001", "PURCHASE", 100),
    move(2, "2026-08-06", "06:00:10", "PURCHASE_IN", 10, "PUR-2026-900090", "PURCHASE", 110),
    move(3, "2026-08-06", "07:00:10", "PURCHASE_REVERSAL_OUT", -10, "PUR-2026-900090", "PURCHASE_EDIT", 100),
  );
  data.inventory!.push({ id: `${wheat.id}|${wh.id}`, productId: wheat.id, warehouseId: wh.id, qty: 100, damagedQty: 0, avgCostP: 50_000, lastCostP: 50_000 });
  // purchases the specs create through the API continue after the highest number on file (no PUR counter was loaded before S13)
  const purMax = Math.max(0, ...data.purchases!.map((p) => Number(/(\d{6})$/.exec(String(p.purchaseNumber ?? ""))?.[1] ?? 0)));
  data.sequences = data.sequences!.filter((x) => x.kind !== "PUR").concat([{ k: "PUR:2026", kind: "PUR", year: 2026, n: purMax, updatedAt: "2026-09-20T09:00:00.000Z" }]);

  const counts: Record<string, number> = {};
  for (const [store, docs] of Object.entries(data)) counts[store] = docs.length;
  (backup as Doc).counts = counts;
  return backup;
}
