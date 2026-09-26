/**
 * Generates fixtures/synthetic-backup.json: a fabricated `farooq-co-erp-backup` with the SAME envelope and the
 * SAME field names as the real nightly backup (key sets copied from the real file; every value invented —
 * no real business data, names or amounts). Run: `pnpm --filter @farooq/import fixture`.
 *
 * It exists because the real backup is thin (12 invoices, 0 returns, 0 opening balances) and would pass even if
 * returns, opening balances, reversals, drafts and cancellations were all broken. Every branch of the legacy
 * Ledger is exercised here, with hand-computed expectations in the tests (see test/legacy-ledger.test.ts).
 *
 * S6 added invoice lines, a second warehouse, stock movements / inventory and the product prices. The 8 invoices keep their
 * grand totals (so every balance below is unchanged); their lines, the stock they moved and the resulting quantities are
 * worked out by hand in `test/invoice-lines-stock.test.ts` (header table and stock-level comments).
 *
 * Money is integer paisa. Expected balances, worked out by hand:
 *   customers  C1 1,900,000  C2 100,000  C3 470,000  C4 15,000  C5 450,000  C6 0        (Σ 2,935,000)
 *   suppliers  S1 870,000    S2 390,000  S3 -40,000  S4 92,000   S5 0                    (Σ net 1,312,000; owed>0 1,352,000)
 *
 * Invoice outstanding (S3: grandTotal − allocations of POSTED payments − credit of non-CANCELLED returns linked to it):
 *   inv-1 1,000,000 − 400,000 = 600,000     inv-2 500,000 − 300,000 = 200,000     inv-5 300,000 (nothing against it)
 *   inv-6 750,000 − 250,000 − 30,000 (DRAFT return cr-3 counts) = 470,000
 *   inv-7 400,000 − 50,000 (cr-4; the CANCELLED cr-2 does not count) = 350,000
 *   inv-8 600,000 − 60,000 (cr-1) = 540,000        (inv-3 DRAFT and inv-4 CANCELLED are never collectable)
 * Purchase outstanding (total − allocations): pur-1 900,000 − 250,000 = 650,000, pur-2 400,000, pur-4 100,000.
 *
 * Purchases (S11) — lines and cost, worked out by hand. The four headers keep their totals, statuses, dates and suppliers (so every balance above holds).
 * The cost figures on each line are what the LEGACY stored (`Cost.allocate`, `17-profit.js`); the average is `Landed.weightedAverage` (setting profitCostBasis: not in
 * the fixture's `business` document, so the legacy default LANDED).
 *   pur-1  L1 p-1 @wh-1  12 bags x 60,000 = 720,000     L2 p-2 @wh-2  3 bags x 40,000 = 120,000  (receivedQty ABSENT = 3)     subtotal 840,000 + freight 40,000 + loading 20,000 = 900,000
 *          charges 60,000 over goods 840,000:  L1 share round(60,000 x 720,000 / 840,000 = 51,428.57) = 51,429   L2 share round(8,571.43) = 8,571   (sum 60,000)
 *          L1 landed = 60,000 + round(51,429 / 12 = 4,285.75) 4,286 + operational 0 (lc-2 CANCELLED) = 64,286
 *          L2 landed = 40,000 + round(8,571 / 3 = 2,857) + round(9,000 / 3 = 3,000) [lc-1, POSTED] = 45,857
 *   pur-2  DRAFT, L1 p-3 @wh-1 10 x 50,000 = 500,000 - line discount 60,000 = 440,000, received 0 (nothing arrived: no stock, still on the balance); subtotal 500,000
 *          - line discount 60,000 - overall discount 40,000 = 400,000 (the header keeps ONE discount figure, 100,000); allocate uses the LINE value 440,000 over received || ordered = 10: goods 44,000
 *   pur-3  CANCELLED, L1 p-2 @wh-1 6 x 50,000 = 300,000, received 6, then reversed (nets 0); not in the ledger and not in any average
 *   pur-4  PARTIALLY_RECEIVED, L1 p-3 @wh-2 100 ordered x 1,000 = 100,000, 60 received. LEGACY goods unit = round(100,000 / 60 = 1,666.67) = 1,667 (stored here);
 *          the fixed allocation (S11 fix 3) divides by the ORDERED bags: 1,000. No charges, so landed = goods.
 * Average cost per stock row (bags received, lines of non-cancelled purchases only):
 *   p-1@wh-1  L1 only                                      64,286                (kept in inventory as avg 64,286, last 64,286)
 *   p-2@wh-2  L2 only                                      45,857
 *   p-3@wh-2  pur-4 only                                    1,667
 *   p-1@wh-2 80,000, p-2@wh-1 85,000 (pur-3 is cancelled), p-3@wh-1 0 (pur-2 received nothing) have NO purchase line that received bags: kept from before.
 * Purchase movements net per purchase x product x warehouse: pur-1 p-1@wh-1 +12 (12 - 12 + 12), p-2@wh-2 +3; pur-2 none; pur-3 0 (+6 - 6); pur-4 p-3@wh-2 +60.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Doc = Record<string, unknown>;

const T = (day: string, time: string) => `${day}T${time}.000Z`;

/* ── builders: full key sets as in the real backup, fabricated values ─────── */

const region = (id: string, en: string, ur: string, routes: string[] = []): Doc => ({ id, ur, en, active: true, routes });

const product = (id: string, en: string, extra: Doc = {}): Doc => ({
  id, ur: en, en, brand: "Fixture", brandEn: "Fixture", cat: "Flour", kg: 50, sku: `SKU-${id}`, barcode: "", supplier: "",
  buy: 0, sell: 0, min: 0, active: true, notes: "",
  sourceCode: id, sourceFolio: "1", name: en, normalizedName: en.toLowerCase(), nameEn: en, searchAliases: [], category: "Flour",
  categoryRaw: "Flour", productType: "BAG", weightKg: 50, unit: "Bag", catalogListedValue: 0, catalogValueIsNull: false,
  priceTypeConfirmed: false, priceConfirmed: false, zeroListedValue: false, supplierIds: [], needsReview: false,
  reviewReason: "", duplicateCandidate: false, categoryNeedsReview: false, sourceFile: "fixture.csv", sourcePage: 1,
  ...extra,
});

const customer = (id: string, code: string, sh: string, extra: Doc = {}): Doc => ({
  id, legacyCode: code, sh, ow: "", nameUr: "", ph: "", wa: "", addr: "", region: "rg-a", regionAssumed: false, area: "",
  areaEn: "", route: "", isCashCounter: false, alsoInFiles: [], bal: 0, tot: 0, ord: 0, bagsOut: 0, lim: null, term: "",
  last: null, legacyTotalSales: 0, legacyTotalCollection: 0, legacyBalanceSigned: 0, active: true, needsReview: false,
  reviewReason: "", possibleDuplicate: false, sourceFile: "fixture.csv",
  ...extra,
});

const supplier = (id: string, code: string, co: string, extra: Doc = {}): Doc => ({
  id, legacyCode: code, co, nameUr: "", cp: "", ph: "", wa: "", lo: "", notes: "", categoryInferred: "", localityClue: "",
  prods: [], paid: 0, due: 0, last: null, legacyTotalSales: 0, legacyTotalCollection: 0, legacyBalanceSigned: 0, active: true,
  needsReview: false, reviewReason: "", accountTypeReview: false, sourceFile: "fixture.csv",
  ...extra,
});

/** One invoice line as the fixture author states it: quantity in bags (may be fractional), money in paisa. */
interface LineSpec {
  p: string;
  wh?: string;
  qty: number;
  unit: number;
  disc?: number;
  tax?: number;
  cost?: number;
  returned?: number;
}
interface Charges {
  invoiceDiscount?: number;
  freight?: number;
  loading?: number;
  other?: number;
}

/** The invoice line documents, in the order they were built (`data.invoiceItems`). */
const invoiceItemDocs: Doc[] = [];

/**
 * An invoice whose HEADER is worked out from its lines with plain integer arithmetic (deliberately not the shared
 * `invoiceTotals`: the fixture is an independent witness, and the tests assert the hand-computed totals in the comment
 * at the top of this file). `grandTotal` = subtotal − item discounts − invoice discount + tax + charges.
 */
const invoice = (id: string, no: string, customerId: string, invoiceDate: string, status: string, createdAt: string, lines: LineSpec[], charges: Charges = {}, extra: Doc = {}): Doc => {
  const whId = (extra.warehouseId as string | undefined) ?? "wh-1";
  const subtotal = lines.reduce((a, l) => a + Math.round(l.unit * l.qty), 0);
  const itemDiscounts = lines.reduce((a, l) => a + (l.disc ?? 0), 0);
  const taxAmount = lines.reduce((a, l) => a + (l.tax ?? 0), 0);
  const invoiceDiscount = charges.invoiceDiscount ?? 0;
  const freightAmount = charges.freight ?? 0;
  const loadingAmount = charges.loading ?? 0;
  const otherCharges = charges.other ?? 0;
  const grandTotal = subtotal - itemDiscounts - invoiceDiscount + taxAmount + freightAmount + loadingAmount + otherCharges;
  lines.forEach((l, i) => {
    const gross = Math.round(l.unit * l.qty);
    invoiceItemDocs.push({
      id: `ii-${id}-${i + 1}`, invoiceId: id, sortOrder: i, productId: l.p, productVariantId: null,
      descriptionSnapshot: `Fixture ${l.p}`, descriptionEnSnapshot: `Fixture ${l.p}`, brandSnapshot: "Fixture", categorySnapshot: "Flour",
      packageSnapshot: "50 KG", skuSnapshot: `SKU-${l.p}`, unit: "Bag", quantity: l.qty, unitPrice: l.unit, discount: l.disc ?? 0,
      tax: l.tax ?? 0, lineTotal: gross - (l.disc ?? 0) + (l.tax ?? 0), costSnapshot: l.cost ?? 0, warehouseId: l.wh ?? whId,
      batchNo: "", notes: "", returnedQty: l.returned ?? 0,
    });
  });
  return {
    id, invoiceNumber: no, clientOpId: `op-${id}`, invoiceType: "SALE", saleOrderId: null, orderNumber: "", dispatchNumber: "",
    customerId, customerCodeSnapshot: "", customerNameSnapshot: "", shopNameSnapshot: "", contactPersonSnapshot: "",
    mobileSnapshot: "", whatsappSnapshot: "", addressSnapshot: "", regionId: "rg-a", regionSnapshot: "", marketSnapshot: "",
    warehouseId: "wh-1", warehouseSnapshot: "Main Godown", salesperson: "", invoiceDate, dueDate: invoiceDate, subtotal,
    discountAmount: itemDiscounts + invoiceDiscount, itemDiscounts, invoiceDiscount, taxAmount, freightAmount, loadingAmount, otherCharges,
    grandTotal, paidAmount: 0, balanceAmount: grandTotal, paymentStatus: "UNPAID", paymentMethod: "", referenceNo: "", status,
    notes: "", totalQty: lines.reduce((a, l) => a + l.qty, 0), lineCount: lines.length, previousBalance: 0, revision: 1, createdBy: "Fixture",
    createdAt, updatedAt: createdAt, confirmedAt: createdAt, cancelledAt: null, cancelReason: "", stockApplied: true,
    ...extra,
  };
};

/* ── stock: every movement carries the running balance the legacy stamps on it, so the fixture's own
      `balanceAfter` chains are consistent by construction; the final `inventory` rows are worked out from the same sums. ── */
const runningMilli = new Map<string, number>();
let movementSeq = 0;
const movement = (day: string, time: string, productId: string, warehouseId: string, kind: string, qtyDelta: number, refType: string, ref: string, extra: { bucket?: string; unitCostP?: number; note?: string; date?: string } = {}): Doc => {
  const bucket = extra.bucket ?? "stock";
  const key = `${productId}|${warehouseId}|${bucket}`;
  const next = (runningMilli.get(key) ?? 0) + Math.round(qtyDelta * 1000);
  runningMilli.set(key, next);
  return {
    id: `mv-${++movementSeq}`, createdAt: T(day, time), date: extra.date ?? day, productId, warehouseId, kind, qtyDelta, bucket, balanceAfter: next / 1000,
    ref, refType, note: extra.note ?? "", unitCostP: extra.unitCostP ?? 0, userId: "Fixture",
  };
};

/**
 * One purchase line as the fixture author states it: bags ordered / received, money in paisa, and the cost figures the LEGACY stored on
 * the line (`goodsUnitCost`, `chargeShare`, `landedUnitCost`, `operationalShare`) — worked out by hand in the header comment. `received`
 * omitted = the `receivedQty` key is ABSENT on the document (the legacy reads that as "the whole line arrived"); 0 = nothing arrived.
 */
interface PurchaseLineSpec {
  p: string;
  wh: string;
  qty: number;
  unit: number;
  disc?: number;
  tax?: number;
  received?: number;
  goods: number;
  share: number;
  landed: number;
  op?: number;
}
interface PurchaseCharges {
  invoiceDiscount?: number;
  freight?: number;
  loading?: number;
  other?: number;
}

/** The purchase line documents, in the order they were built (`data.purchaseItems`). */
const purchaseItemDocs: Doc[] = [];

/**
 * A purchase whose HEADER is worked out from its lines with plain integer arithmetic (deliberately not the shared `invoiceTotals`: the
 * fixture is an independent witness). `grandTotal` = subtotal − item discounts − overall discount + tax + freight + loading + other; the
 * legacy keeps line + overall discounts as ONE figure (`discountAmount`). The header's godown is the default; lines carry their own.
 */
const purchase = (id: string, no: string, supplierId: string, purchaseDate: string, status: string, createdAt: string, lines: PurchaseLineSpec[], charges: PurchaseCharges = {}, extra: Doc = {}): Doc => {
  const subtotal = lines.reduce((a, l) => a + l.qty * l.unit, 0);
  const itemDiscounts = lines.reduce((a, l) => a + (l.disc ?? 0), 0);
  const taxAmount = lines.reduce((a, l) => a + (l.tax ?? 0), 0);
  const overall = charges.invoiceDiscount ?? 0;
  const freightAmount = charges.freight ?? 0;
  const loadingAmount = charges.loading ?? 0;
  const otherCharges = charges.other ?? 0;
  const grandTotal = subtotal - itemDiscounts - overall + taxAmount + freightAmount + loadingAmount + otherCharges;
  const orderedQty = lines.reduce((a, l) => a + l.qty, 0);
  const receivedQty = lines.reduce((a, l) => a + (l.received ?? l.qty), 0);
  lines.forEach((l, i) => {
    const doc: Doc = {
      id: `pi-${id}-${i + 1}`, purchaseId: id, sortOrder: i, productId: l.p, descriptionSnapshot: `Fixture ${l.p}`, descriptionEnSnapshot: `Fixture ${l.p}`,
      brandSnapshot: "Fixture", packageSnapshot: "50 KG", quantity: l.qty, orderedQty: l.qty, receivedQty: l.received ?? l.qty, unit: "Bag", unitPrice: l.unit,
      discount: l.disc ?? 0, tax: l.tax ?? 0, lineTotal: l.qty * l.unit - (l.disc ?? 0) + (l.tax ?? 0), warehouseId: l.wh, batchNo: "", returnedQty: 0, notes: "",
      goodsUnitCost: l.goods, chargeShare: l.share, landedUnitCost: l.landed,
    };
    if (l.received === undefined) delete doc.receivedQty;
    if (l.op !== undefined) doc.operationalShare = l.op;
    purchaseItemDocs.push(doc);
  });
  return {
    id, purchaseNumber: no, clientOpId: `op-${id}`, supplierId, supplierNameSnapshot: SNAP[supplierId]?.[0] ?? "", supplierInvoiceNo: "", warehouseId: "wh-1",
    warehouseSnapshot: "Main Godown", purchaseDate, vehicleNo: "", driver: "", deliveryRef: "", subtotal, discountAmount: itemDiscounts + overall,
    taxAmount, freightAmount, loadingAmount, otherCharges, grandTotal, paidAmount: 0, balanceAmount: grandTotal,
    paymentStatus: "UNPAID", status, notes: "", totalQty: orderedQty, lineCount: lines.length, createdBy: "Fixture", createdAt, updatedAt: createdAt,
    stockApplied: receivedQty > 0, orderedQty, receivedQty, revision: 1,
    ...extra,
  };
};

/** What a voucher printed about its party when it was made (name, owner, region as "اردو — English"): the legacy `*Snapshot` fields. */
const SNAP: Record<string, [string, string, string]> = {
  "cust-1": ["Al-Noor Traders", "Noor", "الفا بازار — Alpha Bazar"],
  "cust-2": ["Bismillah Store", "", "بیٹا منڈی — Beta Mandi"],
  "cust-3": ["Cash Counter", "", "الفا بازار — Alpha Bazar"],
  "cust-4": ["Delta Kiryana", "", "الفا بازار — Alpha Bazar"],
  "cust-5": ["دکان فاروق", "فاروق", "الفا بازار — Alpha Bazar"],
  "sup-1": ["Sunrise Mills Ltd", "", ""],
  "sup-2": ["Tariq Brothers", "", ""],
  "sup-4": ["الفلاح ملز", "", ""],
};

const payment = (id: string, receiptNumber: string, direction: "IN" | "OUT", partyType: "CUSTOMER" | "SUPPLIER", partyId: string, amount: number, paymentDate: string, createdAt: string, extra: Doc = {}): Doc => ({
  id, receiptNumber, direction, partyId, partyType, isRefund: partyType === "CUSTOMER" && direction === "OUT",
  partyNameSnapshot: SNAP[partyId]?.[0] ?? "", partyOwnerSnapshot: SNAP[partyId]?.[1] ?? "", regionSnapshot: SNAP[partyId]?.[2] ?? "", amount, method: "Cash", reference: "", paymentDate, note: "",
  receivedBy: "Fixture", status: "POSTED", createdAt, createdBy: "Fixture", balanceBefore: 0, balanceAfter: 0,
  ...extra,
});

const allocation = (id: string, paymentId: string, target: { invoiceId?: string; purchaseId?: string }, amount: number, createdAt: string): Doc => ({
  id, paymentId, invoiceId: target.invoiceId ?? null, purchaseId: target.purchaseId ?? null, amount, createdAt,
});

const customerReturn = (id: string, no: string, customerId: string, invoiceId: string, invoiceNumber: string, returnDate: string, creditAmount: number, status: string, treatment: string, createdAt: string): Doc => ({
  id, returnNumber: no, clientOpId: `op-${id}`, invoiceId, invoiceNumber, customerId, customerNameSnapshot: "",
  regionSnapshot: "", warehouseId: "wh-1", warehouseSnapshot: "Main Godown", returnDate, reason: "", treatment, condition: "",
  notes: "", description: "", creditAmount, replacementValue: 0, totalQty: 1, lineCount: 1, status, createdBy: "Fixture", createdAt,
});

const supplierReturn = (id: string, no: string, supplierId: string, returnDate: string, debitAmount: number, status: string, createdAt: string): Doc => ({
  id, returnNumber: no, clientOpId: `op-${id}`, supplierId, supplierNameSnapshot: "", purchaseId: null, purchaseNumber: "",
  warehouseId: "wh-1", warehouseSnapshot: "Main Godown", returnDate, reason: "", notes: "", description: "", expectReplacement: false,
  debitAmount, totalQty: 1, lineCount: 1, status, createdBy: "Fixture", createdAt,
});

const adjustment = (id: string, no: string, customerId: string, adjustmentDate: string, direction: "DEBIT" | "CREDIT", amount: number, status: string, createdAt: string, extra: Doc = {}): Doc => ({
  id, adjustmentNumber: no, clientOpId: `op-${id}`, customerId, customerNameSnapshot: "", adjustmentDate, direction, amount,
  reason: "Other correction", notes: "", description: "", status, createdBy: "Fixture", createdAt,
  ...extra,
});

const millingJob = (id: string, no: string, millId: string, jobDate: string, settle: string, issuedValue: number, receivedValue: number, feeAmount: number, status: string, createdAt: string): Doc => ({
  id, jobNumber: no, clientOpId: id, jobDate, millId, millSnapshot: "", warehouseId: "wh-1", warehouseSnapshot: "Main Godown", settle,
  receiveMode: "AT_MILL", inWeightKg: 1000, outWeightKg: 950, lossKg: 50, lossPct: 5, issuedValue, receivedValue, feeAmount, feeNote: "",
  netAmount: receivedValue + feeAmount - issuedValue, notes: "", status, cancelReason: "", createdBy: "Fixture", createdAt,
});

const seq = (kind: string, n: number) => ({ k: `${kind}:2026`, kind, year: 2026, n, updatedAt: T("2026-02-28", "09:00:00") });

/* ── the fixture ─────────────────────────────────────────────────────────── */

export function buildFixture() {
  // module-level builders keep running state (line documents, stock balances): a fresh fixture starts from nothing
  invoiceItemDocs.length = 0;
  purchaseItemDocs.length = 0;
  runningMilli.clear();
  movementSeq = 0;
  const data: Record<string, Doc[]> = {
    regions: [region("rg-a", "Alpha Bazar", "الفا بازار", ["R1"]), region("rg-b", "Beta Mandi", "بیٹا منڈی")],
    warehouses: [{ id: "wh-1", name: "Main Godown", active: true }, { id: "wh-2", name: "Second Godown", active: true }],
    products: [
      // the Prices panel has been used on this one: the `...P` paisa fields AND the mirrored rupee fields (21-settings.js writes both)
      product("p-1", "Fixture Flour 50kg", {
        buyP: 80_000, buy: 800, extraP: 2000, extra: 20, sellP: 100_000, sell: 1000, minSellP: 95_000, min: 950, wholesaleP: 98_000,
        retailP: 105_000, discountPct: 2.5, taxPct: 5, reorder: 20,
      }),
      // only the legacy rupee fields (never opened in the Prices panel): 900.50 rupees = 90,050 paisa
      product("p-2", "Fixture Sugar 50kg", { category: "Sugar", cat: "Sugar", sell: 900.5, min: 850 }),
      // like 3 real products: an older shape with no `name`/`category`/`unit` — the importer falls back to en / cat
      { id: "p-3", ur: "Fixture Rice", en: "Fixture Rice", brand: "Fixture", brandEn: "Fixture", cat: "Rice", kg: 25, sku: "SKU-p-3", barcode: "", supplier: "", buy: 0, sell: 0, min: 0, active: true },
    ],
    customers: [
      // opening balance WITH a date; the OPENING row leads the statement regardless
      customer("cust-1", "C01", "Al-Noor Traders", { ow: "Noor", openingBalanceP: 500000, openingBalanceDate: "2026-01-01" }),
      // negative opening (a credit balance), no date -> 2000-01-01
      customer("cust-2", "C02", "Bismillah Store", { openingBalanceP: -200000, region: "rg-b" }),
      customer("cust-3", "C03", "Cash Counter", { isCashCounter: true }),
      customer("cust-4", "C04", "Delta Kiryana"),
      // Urdu (UTF-8) names
      customer("cust-5", "C05", "دکان فاروق", { ow: "فاروق", nameUr: "دکان فاروق", ph: "0300-0000000" }),
      // no activity, but a nonzero legacy paper-book figure that must NOT be posted
      customer("cust-6", "C06", "Echo Mart", { legacyTotalSales: 1234500, legacyTotalCollection: 234500, legacyBalanceSigned: 1000000, bal: 777, tot: 888 }),
    ],
    suppliers: [
      supplier("sup-1", "S01", "Sunrise Mills Ltd", { openingBalanceP: 300000, openingBalanceDate: "2026-01-05" }),
      supplier("sup-2", "S02", "Tariq Brothers"),
      supplier("sup-3", "S03", "Umar Agro", { openingBalanceP: -40000 }),
      supplier("sup-4", "S04", "الفلاح ملز", { nameUr: "الفلاح ملز" }), // a mill (has milling jobs)
      supplier("sup-5", "S05", "Vega Traders", { legacyTotalSales: 5000, legacyBalanceSigned: 5000 }),
    ],
    invoices: [
      // several documents on the same day (tie-break by createdAt): inv-1 then inv-2. Lines are worked out by hand in the header
      // comment; p-1 costs 80,000 a bag, p-2 85,000, p-3 has no recorded cost (0).
      invoice("inv-1", "INV-2026-000001", "cust-1", "2026-02-01", "CONFIRMED", T("2026-02-01", "05:00:00"),
        [{ p: "p-1", qty: 10, unit: 100_000, cost: 80_000 }]),
      // TWO lines, one with an item discount; EDITED after posting (revision 2: the stock was reversed and re-deducted)
      invoice("inv-2", "INV-2026-000002", "cust-1", "2026-02-01", "PAID", T("2026-02-01", "06:00:00"),
        [{ p: "p-2", qty: 4, unit: 90_000, cost: 85_000 }, { p: "p-3", qty: 2, unit: 80_000, disc: 20_000, cost: 0 }],
        {}, { revision: 2, previousBalance: 1_000_000, updatedAt: T("2026-02-02", "05:00:00") }),
      // a DRAFT with lines: no number, no stock, stockApplied false — and it is not in the ledger
      invoice("inv-3", "", "cust-1", "2026-02-03", "DRAFT", T("2026-02-03", "05:00:00"),
        [{ p: "p-1", qty: 3, unit: 333_333, cost: 80_000 }], {}, { stockApplied: false, confirmedAt: null, revision: 0 }),
      // CANCELLED: its stock came back (INVOICE_CANCEL), stockApplied false
      invoice("inv-4", "INV-2026-000003", "cust-1", "2026-02-04", "CANCELLED", T("2026-02-04", "05:00:00"),
        [{ p: "p-2", qty: 2, unit: 444_444, cost: 85_000 }], {}, { cancelledAt: T("2026-02-04", "07:00:00"), cancelReason: "typo", stockApplied: false }),
      // the rich one: two lines from two godowns (header on wh-2), item discount, a taxed line, an invoice discount, all three
      // charges, a negative (credit) previous balance; DISPATCHED (a dispatch note exists)
      invoice("inv-5", "INV-2026-000004", "cust-2", "2026-02-10", "DISPATCHED", T("2026-02-10", "05:00:00"),
        [{ p: "p-1", wh: "wh-2", qty: 3, unit: 100_000, disc: 15_000, cost: 80_000 }, { p: "p-2", wh: "wh-1", qty: 2, unit: 50_000, tax: 5000, cost: 85_000 }],
        { invoiceDiscount: 110_000, freight: 12_000, loading: 5000, other: 3000 },
        { warehouseId: "wh-2", warehouseSnapshot: "Second Godown", dispatchNumber: "DSP-2026-000001", previousBalance: -200_000, paymentMethod: "Cash", referenceNo: "REF-5", notes: "deliver in the morning", salesperson: "Ali" }),
      // a FRACTIONAL quantity: 2.5 bags
      invoice("inv-6", "INV-2026-000005", "cust-3", "2026-02-11", "PARTIALLY_PAID", T("2026-02-11", "05:00:00"),
        [{ p: "p-1", qty: 2.5, unit: 300_000, cost: 80_000 }]),
      // made by the old app's data migration: stockApplied true but NO SALE_OUT movement (no lines' stock was ever taken)
      invoice("inv-7", "INV-2026-000006", "cust-5", "2026-02-12", "CONFIRMED", T("2026-02-12", "05:00:00"),
        [{ p: "p-3", qty: 5, unit: 80_000, cost: 0 }], {}, { migrated: true, salesperson: "Migrated", createdBy: "system", notes: "Migrated from the previous single-product sale record s-1" }),
      // PARTIALLY_RETURNED: 0.6 bag of the first line came back (credit note cr-1 = 0.6 x 100,000 = 60,000), as damaged stock
      invoice("inv-8", "INV-2026-000007", "cust-1", "2026-02-15", "PARTIALLY_RETURNED", T("2026-02-15", "05:00:00"),
        [{ p: "p-1", qty: 4, unit: 100_000, cost: 80_000, returned: 0.6 }, { p: "p-2", qty: 2, unit: 100_000, cost: 85_000 }]),
    ],
    // Lines and cost figures are worked out by hand in the header comment ("Purchases (S11)"); the totals, statuses, dates and suppliers
    // are the ones every M1 / M2 number was built on.
    purchases: [
      // RECEIVED and EDITED once (PURCHASE_IN -> PURCHASE_REVERSAL_OUT -> PURCHASE_IN on both lines). TWO lines in TWO godowns, freight + loading spread over
      // them, the second line's `receivedQty` ABSENT (= all 3 arrived) and carrying a landed-cost entry (operationalShare 9,000); the first line's
      // landed-cost entry was CANCELLED (operationalShare 0, a number, not absent)
      purchase("pur-1", "PUR-2026-000001", "sup-1", "2026-02-20", "RECEIVED", T("2026-02-20", "09:00:00"),
        [
          { p: "p-1", wh: "wh-1", qty: 12, unit: 60_000, received: 12, goods: 60_000, share: 51_429, landed: 64_286, op: 0 },
          { p: "p-2", wh: "wh-2", qty: 3, unit: 40_000, goods: 40_000, share: 8_571, landed: 45_857, op: 9_000 },
        ],
        { freight: 40_000, loading: 20_000 }, { revision: 2, updatedAt: T("2026-02-21", "09:00:00") }),
      // a DRAFT bill nothing has arrived for (received 0): no stock, still on the supplier's balance (DRAFT purchases count). It carries BOTH kinds of
      // discount: 60,000 on the line and 40,000 overall; the legacy keeps them as ONE figure (discountAmount 100,000) and the overall part is what is not on a line
      purchase("pur-2", "PUR-2026-000002", "sup-2", "2026-02-22", "DRAFT", T("2026-02-22", "05:00:00"),
        [{ p: "p-3", wh: "wh-1", qty: 10, unit: 50_000, disc: 60_000, received: 0, goods: 44_000, share: 0, landed: 44_000 }], { invoiceDiscount: 40_000 }),
      // CANCELLED: its 6 bags came back out (nets 0), it is not in the ledger and not in any average
      purchase("pur-3", "PUR-2026-000003", "sup-2", "2026-02-22", "CANCELLED", T("2026-02-22", "06:00:00"),
        [{ p: "p-2", wh: "wh-1", qty: 6, unit: 50_000, received: 6, goods: 50_000, share: 0, landed: 50_000 }], {}, { stockApplied: false }),
      // a PART DELIVERY (fix 3's case): 100 bags ordered at 1,000, 60 arrived, into the SECOND godown. The legacy divided the line by the RECEIVED bags:
      // goods unit round(100,000 / 60) = 1,667 — what this backup stores; the fixed allocation says 1,000
      purchase("pur-4", "PUR-2026-000004", "sup-4", "2026-02-25", "PARTIALLY_RECEIVED", T("2026-02-25", "05:00:00"),
        [{ p: "p-3", wh: "wh-2", qty: 100, unit: 1_000, received: 60, goods: 1_667, share: 0, landed: 1_667 }]),
    ],
    payments: [
      // partial allocations across two invoices
      payment("pay-1", "REC-2026-000001", "IN", "CUSTOMER", "cust-1", 700000, "2026-02-05", T("2026-02-05", "07:00:00"), { method: "Bank Transfer" }),
      // REVERSED
      payment("pay-2", "REC-2026-000002", "IN", "CUSTOMER", "cust-1", 200000, "2026-02-06", T("2026-02-06", "07:00:00"), { status: "REVERSED", reversedAt: T("2026-02-07", "08:00:00"), reverseReason: "wrong shop" }),
      // customer refund (OUT, isRefund)
      payment("pay-3", "PV-2026-000001", "OUT", "CUSTOMER", "cust-5", 100000, "2026-02-14", T("2026-02-14", "07:00:00"), { note: "Refund to shop" }),
      // supplier payment, same day as pur-1 but created later (legacy sorts it first — no createdAt on its ledger row)
      payment("pay-4", "PV-2026-000002", "OUT", "SUPPLIER", "sup-1", 250000, "2026-02-20", T("2026-02-20", "10:00:00"), { method: "JazzCash" }),
      payment("pay-5", "PV-2026-000003", "OUT", "SUPPLIER", "sup-2", 50000, "2026-02-22", T("2026-02-22", "07:00:00"), { status: "REVERSED", reversedAt: T("2026-02-23", "08:00:00"), reverseReason: "duplicate" }),
      payment("pay-6", "REC-2026-000003", "IN", "CUSTOMER", "cust-3", 250000, "2026-02-12", T("2026-02-12", "07:00:00")),
      // the cash side of a customer return with the REFUND treatment (linked by reference + note prefix)
      payment("pay-7", "PV-2026-000004", "OUT", "CUSTOMER", "cust-1", 60000, "2026-02-16", T("2026-02-16", "07:00:00"), { reference: "CR-2026-000001", note: "Refund against return CR-2026-000001" }),
    ],
    paymentAllocations: [
      allocation("al-1", "pay-1", { invoiceId: "inv-1" }, 400000, T("2026-02-05", "07:00:00")),
      allocation("al-2", "pay-1", { invoiceId: "inv-2" }, 300000, T("2026-02-05", "07:00:00")),
      allocation("al-3", "pay-4", { purchaseId: "pur-1" }, 250000, T("2026-02-20", "10:00:00")),
      allocation("al-4", "pay-6", { invoiceId: "inv-6" }, 250000, T("2026-02-12", "07:00:00")),
    ],
    customerReturns: [
      customerReturn("cr-1", "CR-2026-000001", "cust-1", "inv-8", "INV-2026-000007", "2026-02-16", 60000, "POSTED", "REFUND", T("2026-02-16", "06:00:00")),
      customerReturn("cr-2", "CR-2026-000002", "cust-5", "inv-7", "INV-2026-000006", "2026-02-13", 40000, "CANCELLED", "CUSTOMER_CREDIT", T("2026-02-13", "05:00:00")),
      customerReturn("cr-3", "CR-2026-000003", "cust-3", "inv-6", "INV-2026-000005", "2026-02-17", 30000, "DRAFT", "CUSTOMER_CREDIT", T("2026-02-17", "05:00:00")), // DRAFT counts
      customerReturn("cr-4", "CR-2026-000004", "cust-5", "inv-7", "INV-2026-000006", "2026-02-18", 50000, "POSTED", "ADJUST_OUTSTANDING_BALANCE", T("2026-02-18", "05:00:00")),
    ],
    supplierReturns: [
      supplierReturn("sr-1", "SR-2026-000001", "sup-1", "2026-02-21", 80000, "POSTED", T("2026-02-21", "05:00:00")),
      supplierReturn("sr-2", "SR-2026-000002", "sup-2", "2026-02-22", 20000, "CANCELLED", T("2026-02-22", "08:00:00")),
      supplierReturn("sr-3", "SR-2026-000003", "sup-2", "2026-02-23", 10000, "DRAFT", T("2026-02-23", "05:00:00")), // DRAFT counts
    ],
    accountAdjustments: [
      adjustment("adj-1", "ACC-2026-000001", "cust-4", "2026-02-28", "DEBIT", 25000, "POSTED", T("2026-02-28", "05:00:00")),
      adjustment("adj-2", "ACC-2026-000002", "cust-4", "2026-02-28", "CREDIT", 10000, "POSTED", T("2026-02-28", "06:00:00")),
      adjustment("adj-3", "ACC-2026-000003", "cust-4", "2026-03-01", "DEBIT", 99000, "REVERSED", T("2026-03-01", "05:00:00"), { reversedAt: T("2026-03-01", "09:00:00"), reverseReason: "entered twice" }),
    ],
    millingJobs: [
      millingJob("mil-1", "MIL-2026-000001", "sup-4", "2026-02-26", "NET", 500000, 450000, 30000, "POSTED", T("2026-02-26", "05:00:00")),
      // FEE_ONLY: only the fee posts even though issuedValue is nonzero (legacy quirk)
      millingJob("mil-2", "MIL-2026-000002", "sup-4", "2026-02-27", "FEE_ONLY", 111000, 0, 12000, "POSTED", T("2026-02-27", "05:00:00")),
      millingJob("mil-3", "MIL-2026-000003", "sup-4", "2026-02-28", "NET", 0, 0, 5000, "CANCELLED", T("2026-02-28", "05:00:00")),
    ],
    sequences: [
      seq("INV", 8), seq("PUR", 4), seq("REC", 3), seq("PV", 4), seq("CR", 4), seq("SR", 3), seq("ACC", 3), seq("MIL", 3),
    ],

    // ── deferred / ignored stores: present so the counts are reconciled, contents fabricated ──
    invoiceItems: invoiceItemDocs,
    purchaseItems: purchaseItemDocs,
    // Final stock, worked out by hand (bags): p-1@wh-1 90.5 (+0.6 damaged), p-1@wh-2 32, p-2@wh-1 52, p-3@wh-1 38, p-2@wh-2 3 (pur-1), p-3@wh-2 60 (pur-4) — see stockMovements.
    // Average costs (S11, worked out in the header comment "Purchases (S11)"): p-1@wh-1 64,286, p-2@wh-2 45,857 and p-3@wh-2 1,667 come from purchase lines;
    // p-1@wh-2 (80,000), p-2@wh-1 (85,000) and p-3@wh-1 (0) have NO purchase line that received bags behind them (pur-3 is cancelled, pur-2 received nothing): kept from before.
    inventory: [
      { id: "p-1|wh-1", productId: "p-1", warehouseId: "wh-1", qty: 90.5, damagedQty: 0.6, avgCostP: 64_286, lastCostP: 64_286 },
      { id: "p-1|wh-2", productId: "p-1", warehouseId: "wh-2", qty: 32, damagedQty: 0, avgCostP: 80_000, lastCostP: 0 },
      { id: "p-2|wh-1", productId: "p-2", warehouseId: "wh-1", qty: 52, damagedQty: 0, avgCostP: 85_000, lastCostP: 85_000 },
      { id: "p-3|wh-1", productId: "p-3", warehouseId: "wh-1", qty: 38, damagedQty: 0, avgCostP: 0, lastCostP: 0 },
      { id: "p-2|wh-2", productId: "p-2", warehouseId: "wh-2", qty: 3, damagedQty: 0, avgCostP: 45_857, lastCostP: 45_857 },
      { id: "p-3|wh-2", productId: "p-3", warehouseId: "wh-2", qty: 60, damagedQty: 0, avgCostP: 1_667, lastCostP: 1_667 },
    ],
    stockMovements: [
      // stock in (January): the legacy names a stock-receipt document in `ref`; stock documents are M4, so it is carried by name
      movement("2026-01-10", "09:00:00", "p-1", "wh-1", "OPENING_STOCK", 100, "STOCK_RECEIPT", "RCV-2026-000001", { unitCostP: 80_000 }),
      movement("2026-01-10", "09:00:01", "p-2", "wh-1", "ADJUSTMENT_IN", 60, "STOCK_RECEIPT", "RCV-2026-000002", { unitCostP: 85_000 }),
      movement("2026-01-10", "09:00:02", "p-3", "wh-1", "ADJUSTMENT_IN", 40, "STOCK_RECEIPT", "RCV-2026-000003"),
      movement("2026-01-10", "09:00:03", "p-1", "wh-2", "ADJUSTMENT_IN", 30, "STOCK_RECEIPT", "RCV-2026-000004", { unitCostP: 80_000 }),
      // inv-1
      movement("2026-02-01", "05:00:10", "p-1", "wh-1", "SALE_OUT", -10, "INVOICE", "INV-2026-000001", { note: "Al-Noor Traders" }),
      // inv-2: first posted with p-3 x 3, then EDITED to p-3 x 2 — the legacy reverses every old line and deducts the new ones
      movement("2026-02-01", "06:00:10", "p-2", "wh-1", "SALE_OUT", -4, "INVOICE", "INV-2026-000002", { note: "Al-Noor Traders" }),
      movement("2026-02-01", "06:00:11", "p-3", "wh-1", "SALE_OUT", -3, "INVOICE", "INV-2026-000002", { note: "Al-Noor Traders" }),
      movement("2026-02-02", "05:00:10", "p-2", "wh-1", "SALE_REVERSAL_IN", 4, "INVOICE_EDIT", "INV-2026-000002", { note: "Reversed on invoice edit" }),
      movement("2026-02-02", "05:00:11", "p-3", "wh-1", "SALE_REVERSAL_IN", 3, "INVOICE_EDIT", "INV-2026-000002", { note: "Reversed on invoice edit" }),
      movement("2026-02-02", "05:00:12", "p-2", "wh-1", "SALE_OUT", -4, "INVOICE", "INV-2026-000002", { note: "Al-Noor Traders" }),
      movement("2026-02-02", "05:00:13", "p-3", "wh-1", "SALE_OUT", -2, "INVOICE", "INV-2026-000002", { note: "Al-Noor Traders" }),
      // inv-4: sold, then CANCELLED — the bags came back
      movement("2026-02-04", "05:00:10", "p-2", "wh-1", "SALE_OUT", -2, "INVOICE", "INV-2026-000003", { note: "Al-Noor Traders" }),
      movement("2026-02-04", "07:00:10", "p-2", "wh-1", "SALE_REVERSAL_IN", 2, "INVOICE_CANCEL", "INV-2026-000003", { note: "Invoice cancelled — typo" }),
      // inv-5: two godowns
      movement("2026-02-10", "05:00:10", "p-1", "wh-2", "SALE_OUT", -3, "INVOICE", "INV-2026-000004", { note: "Bismillah Store" }),
      movement("2026-02-10", "05:00:11", "p-2", "wh-1", "SALE_OUT", -2, "INVOICE", "INV-2026-000004", { note: "Bismillah Store" }),
      // inv-6: 2.5 bags
      movement("2026-02-11", "05:00:10", "p-1", "wh-1", "SALE_OUT", -2.5, "INVOICE", "INV-2026-000005", { note: "Cash Counter" }),
      // inv-7 is a migrated invoice: NO movement here (that is the point)
      // inv-8, then its return: 0.6 bag came back damaged (the damaged bucket)
      movement("2026-02-15", "05:00:10", "p-1", "wh-1", "SALE_OUT", -4, "INVOICE", "INV-2026-000007", { note: "Al-Noor Traders" }),
      movement("2026-02-15", "05:00:11", "p-2", "wh-1", "SALE_OUT", -2, "INVOICE", "INV-2026-000007", { note: "Al-Noor Traders" }),
      movement("2026-02-16", "06:00:10", "p-1", "wh-1", "CUSTOMER_RETURN_DAMAGED_IN", 0.6, "CUSTOMER_RETURN", "CR-2026-000001", { bucket: "damaged", note: "Return CR-2026-000001" }),
      // pur-1 (received), edited once (reverse + re-add): PURCHASE_EDIT links to the purchase by its number too
      movement("2026-02-20", "09:00:10", "p-1", "wh-1", "PURCHASE_IN", 12, "PURCHASE", "PUR-2026-000001", { unitCostP: 60_000, note: "Sunrise Mills Ltd" }),
      movement("2026-02-21", "09:00:10", "p-1", "wh-1", "PURCHASE_REVERSAL_OUT", -12, "PURCHASE_EDIT", "PUR-2026-000001", { note: "Reversed on purchase edit" }),
      movement("2026-02-21", "09:00:11", "p-1", "wh-1", "PURCHASE_IN", 12, "PURCHASE", "PUR-2026-000001", { unitCostP: 60_000, note: "Sunrise Mills Ltd" }),
      // a transfer between the two godowns
      movement("2026-02-22", "10:00:10", "p-1", "wh-1", "TRANSFER_OUT", -5, "TRANSFER", "TRF-2026-000001"),
      movement("2026-02-22", "10:00:11", "p-1", "wh-2", "TRANSFER_IN", 5, "TRANSFER", "TRF-2026-000001"),
      // pur-1's SECOND line (p-2 into the second godown), with the same edit history: the edit's reversal is dated the ORIGINAL purchase date
      movement("2026-02-20", "09:00:12", "p-2", "wh-2", "PURCHASE_IN", 3, "PURCHASE", "PUR-2026-000001", { unitCostP: 40_000, note: "Sunrise Mills Ltd" }),
      movement("2026-02-21", "09:00:12", "p-2", "wh-2", "PURCHASE_REVERSAL_OUT", -3, "PURCHASE_EDIT", "PUR-2026-000001", { note: "Reversed on purchase edit", date: "2026-02-20" }),
      movement("2026-02-21", "09:00:13", "p-2", "wh-2", "PURCHASE_IN", 3, "PURCHASE", "PUR-2026-000001", { unitCostP: 40_000, note: "Sunrise Mills Ltd" }),
      // pur-3 was received, then CANCELLED: the 6 bags came back out (net 0)
      movement("2026-02-22", "06:00:10", "p-2", "wh-1", "PURCHASE_IN", 6, "PURCHASE", "PUR-2026-000003", { unitCostP: 50_000, note: "Tariq Brothers" }),
      movement("2026-02-22", "07:00:10", "p-2", "wh-1", "PURCHASE_REVERSAL_OUT", -6, "PURCHASE_EDIT", "PUR-2026-000003", { note: "Reversed on purchase cancel" }),
      // pur-4: 60 of the 100 ordered bags arrived (pur-2 received nothing: no movement)
      movement("2026-02-25", "05:00:10", "p-3", "wh-2", "PURCHASE_IN", 60, "PURCHASE", "PUR-2026-000004", { unitCostP: 1_000, note: "الفلاح ملز" }),
      // S14 (old repo b2b0778): RCV-2026-000004 was EDITED on 02-26 from 30 bags @ 800.00 to 30 @ 900.00 — `StockDocs.editReceive` takes the old line back OUT at its OLD cost, dated as the
      // original receipt (RECEIPT_EDIT_OUT / STOCK_RECEIPT_EDIT), then posts the corrected one. The bags net 0 (p-1@wh-2 stays 32); carried cost p-1@wh-2 = (30x80,000 - 30x80,000 + 30x90,000) / 30 = 90,000
      // (WITHOUT the subtraction it would be the 85,000 average of both). The stock row keeps its recorded average 80,000, which `costOf` reads first.
      movement("2026-02-26", "10:00:00", "p-1", "wh-2", "RECEIPT_EDIT_OUT", -30, "STOCK_RECEIPT_EDIT", "RCV-2026-000004", { unitCostP: 80_000, date: "2026-01-10", note: "Reversed on receipt edit" }),
      movement("2026-02-26", "10:00:01", "p-1", "wh-2", "ADJUSTMENT_IN", 30, "STOCK_RECEIPT", "RCV-2026-000004", { unitCostP: 90_000 }),
    ],
    // Landed cost (a deferred store — M6 — but reconciliation READS it): lc-1 put 9,000 of unloading on pur-1's second line (3 bags: 3,000 a bag), lc-2 put 5,000
    // on its first line and was CANCELLED, so that line's operational share is 0 and only lc-1 counts. Shapes are the real v710 rows' key sets.
    landedCosts: [
      { id: "lc-1", referenceNumber: "LC-2026-000001", purchaseId: "pur-1", purchaseNumber: "PUR-2026-000001", transferId: null, warehouseId: "wh-2", costDate: "2026-02-23", totalAmount: 9_000, goodsValue: 120_000, notes: "", description: "", status: "POSTED", createdBy: "Fixture", createdAt: T("2026-02-23", "09:00:00") },
      { id: "lc-2", referenceNumber: "LC-2026-000002", purchaseId: "pur-1", purchaseNumber: "PUR-2026-000001", transferId: null, warehouseId: "wh-1", costDate: "2026-02-23", totalAmount: 5_000, goodsValue: 720_000, notes: "", description: "", status: "CANCELLED", createdBy: "Fixture", createdAt: T("2026-02-23", "10:00:00") },
    ],
    landedCostExpenses: [
      { id: "lce-1", landedCostId: "lc-1", category: "Unloading", description: "", amountP: 9_000, vendorName: "", paymentStatus: "UNPAID", expenseDate: "2026-02-23" },
      { id: "lce-2", landedCostId: "lc-2", category: "Unloading", description: "", amountP: 5_000, vendorName: "", paymentStatus: "UNPAID", expenseDate: "2026-02-23" },
    ],
    inventoryCostAdjust: [
      { id: "ica-1", landedCostId: "lc-1", productId: "p-2", purchaseItemId: "pi-pur-1-2", purchaseId: "pur-1", warehouseId: "wh-2", purchaseCost: 40_000, additionalCost: 9_000, landedCost: 43_000, quantity: 3, costPerUnit: 43_000, createdAt: T("2026-02-23", "09:00:00") },
      { id: "ica-2", landedCostId: "lc-2", productId: "p-1", purchaseItemId: "pi-pur-1-1", purchaseId: "pur-1", warehouseId: "wh-1", purchaseCost: 60_000, additionalCost: 5_000, landedCost: 60_417, quantity: 12, costPerUnit: 60_417, createdAt: T("2026-02-23", "10:00:00") },
    ],
    operations: [{ opId: "op-inv-1", entity: "Invoice", entityId: "inv-1", ref: "INV-2026-000001", createdAt: T("2026-02-01", "05:00:00"), state: "DONE" }],
    // credentials store: fabricated pin/salt; must never be imported or read
    users: [{ id: "u-1", createdAt: T("2026-01-01", "00:00:00"), createdBy: "system", pin: "FIXTURE-PIN-HASH", salt: "FIXTURE-SALT", active: true, lastSignIn: null, name: "Fixture Owner", role: "OWNER" }],
    syncQueue: [],
    meta: [{ k: "appVersion", v: "fixture" }],
    legacy: [{ k: "seq", v: {} }],
    // the settings bag, fabricated: same key names as the real one (incl. the boolean `requirePinOnSwitch`, which must NOT be mistaken for a credential)
    business: [{
      id: "biz", businessName: "Fixture & Co", legalName: "Fixture & Co Traders", tagline: "Wholesale Dealer", taglineUr: "ہول سیل ڈیلر",
      slogan: "Trust in every bag", logoText: "F&C", logoDataUrl: "", address: "1 Fixture Road", city: "Testville", phone: "0300-1111111",
      shopPhone: "0944-000000", whatsapp: "", email: "", website: "", ntn: "", registrationNo: "", proprietor: "Fixture Owner",
      invoicePrefix: "INV", purchasePrefix: "PUR", receiptPrefix: "REC", currency: "PKR", currencyLabel: "PKR", taxEnabled: false,
      invoiceFooter: "Thank you.", terms: "Fixture terms", bankDetails: "Fixture Bank 0000", preparedByLabel: "Prepared by",
      receivedByLabel: "Received by", smsProvider: "", smsSenderId: "", requirePinOnSwitch: false, autoBackup: true,
      categories: ["Flour", "Sugar"], brands: [], units: ["Bag"], updatedAt: T("2026-02-01", "05:00:00"),
    }],
  };
  // every other store the real backup has, empty
  for (const s of [
    "customerReturnItems", "supplierReturnItems", "stockDocs", "stockDocItems", "orders", "orderItems",
    "expenses", "employees", "salaryPayments", "millingJobItems",
    "millingArrivals", "supplierProducts", "priceHistory", "priceApprovals", "costHistory", "salesmen", "documents", "documentEdits",
    "auditLog", "migrationBackups",
  ]) data[s] = [];

  const counts: Record<string, number> = {};
  for (const [store, docs] of Object.entries(data)) counts[store] = docs.length;

  return {
    format: "farooq-co-erp-backup",
    formatVersion: 1,
    appVersion: "fixture",
    exportedAt: "2026-03-01T10:00:00.000Z",
    driver: "synthetic",
    serverVersion: "fixture",
    counts,
    data,
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(here, "synthetic-backup.json");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  console.log(`wrote ${FIXTURE_PATH}`);
}
