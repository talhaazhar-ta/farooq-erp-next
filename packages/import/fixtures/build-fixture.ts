/**
 * Generates fixtures/synthetic-backup.json: a fabricated `farooq-co-erp-backup` with the SAME envelope and the
 * SAME field names as the real nightly backup (key sets copied from the real file; every value invented —
 * no real business data, names or amounts). Run: `pnpm --filter @farooq/import fixture`.
 *
 * It exists because the real backup is thin (12 invoices, 0 returns, 0 opening balances) and would pass even if
 * returns, opening balances, reversals, drafts and cancellations were all broken. Every branch of the legacy
 * Ledger is exercised here, with hand-computed expectations in the tests (see test/legacy-ledger.test.ts).
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

const invoice = (id: string, no: string, customerId: string, invoiceDate: string, grandTotal: number, status: string, createdAt: string, extra: Doc = {}): Doc => ({
  id, invoiceNumber: no, clientOpId: `op-${id}`, invoiceType: "SALE", saleOrderId: null, orderNumber: "", dispatchNumber: "",
  customerId, customerCodeSnapshot: "", customerNameSnapshot: "", shopNameSnapshot: "", contactPersonSnapshot: "",
  mobileSnapshot: "", whatsappSnapshot: "", addressSnapshot: "", regionId: "rg-a", regionSnapshot: "", marketSnapshot: "",
  warehouseId: "wh-1", warehouseSnapshot: "Main Godown", salesperson: "", invoiceDate, dueDate: invoiceDate, subtotal: grandTotal,
  discountAmount: 0, itemDiscounts: 0, invoiceDiscount: 0, taxAmount: 0, freightAmount: 0, loadingAmount: 0, otherCharges: 0,
  grandTotal, paidAmount: 0, balanceAmount: grandTotal, paymentStatus: "UNPAID", paymentMethod: "", referenceNo: "", status,
  notes: "", totalQty: 10, lineCount: 1, previousBalance: 0, revision: 1, createdBy: "Fixture", createdAt, updatedAt: createdAt,
  confirmedAt: createdAt, cancelledAt: null, cancelReason: "", stockApplied: true,
  ...extra,
});

const purchase = (id: string, no: string, supplierId: string, purchaseDate: string, grandTotal: number, status: string, createdAt: string): Doc => ({
  id, purchaseNumber: no, clientOpId: `op-${id}`, supplierId, supplierNameSnapshot: "", supplierInvoiceNo: "", warehouseId: "wh-1",
  warehouseSnapshot: "Main Godown", purchaseDate, vehicleNo: "", driver: "", deliveryRef: "", subtotal: grandTotal, discountAmount: 0,
  taxAmount: 0, freightAmount: 0, loadingAmount: 0, otherCharges: 0, grandTotal, paidAmount: 0, balanceAmount: grandTotal,
  paymentStatus: "UNPAID", status, notes: "", totalQty: 10, lineCount: 1, createdBy: "Fixture", createdAt, updatedAt: createdAt,
  stockApplied: true, orderedQty: 10, receivedQty: 10, revision: 1,
});

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
  const data: Record<string, Doc[]> = {
    regions: [region("rg-a", "Alpha Bazar", "الفا بازار", ["R1"]), region("rg-b", "Beta Mandi", "بیٹا منڈی")],
    warehouses: [{ id: "wh-1", name: "Main Godown", active: true }],
    products: [
      product("p-1", "Fixture Flour 50kg"),
      product("p-2", "Fixture Sugar 50kg", { category: "Sugar", cat: "Sugar" }),
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
      // several documents on the same day (tie-break by createdAt): inv-1 then inv-2
      invoice("inv-1", "INV-2026-000001", "cust-1", "2026-02-01", 1000000, "CONFIRMED", T("2026-02-01", "05:00:00")),
      invoice("inv-2", "INV-2026-000002", "cust-1", "2026-02-01", 500000, "PAID", T("2026-02-01", "06:00:00")),
      invoice("inv-3", "", "cust-1", "2026-02-03", 999999, "DRAFT", T("2026-02-03", "05:00:00")), // drafts take no number
      invoice("inv-4", "INV-2026-000003", "cust-1", "2026-02-04", 888888, "CANCELLED", T("2026-02-04", "05:00:00"), { cancelledAt: T("2026-02-04", "07:00:00"), cancelReason: "typo" }),
      invoice("inv-5", "INV-2026-000004", "cust-2", "2026-02-10", 300000, "CONFIRMED", T("2026-02-10", "05:00:00")),
      invoice("inv-6", "INV-2026-000005", "cust-3", "2026-02-11", 750000, "PARTIALLY_PAID", T("2026-02-11", "05:00:00")),
      invoice("inv-7", "INV-2026-000006", "cust-5", "2026-02-12", 400000, "CONFIRMED", T("2026-02-12", "05:00:00")),
      invoice("inv-8", "INV-2026-000007", "cust-1", "2026-02-15", 600000, "PARTIALLY_RETURNED", T("2026-02-15", "05:00:00")),
    ],
    purchases: [
      purchase("pur-1", "PUR-2026-000001", "sup-1", "2026-02-20", 900000, "RECEIVED", T("2026-02-20", "09:00:00")),
      purchase("pur-2", "PUR-2026-000002", "sup-2", "2026-02-22", 400000, "DRAFT", T("2026-02-22", "05:00:00")), // DRAFT purchases count
      purchase("pur-3", "PUR-2026-000003", "sup-2", "2026-02-22", 300000, "CANCELLED", T("2026-02-22", "06:00:00")),
      purchase("pur-4", "PUR-2026-000004", "sup-4", "2026-02-25", 100000, "ORDERED", T("2026-02-25", "05:00:00")),
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
    invoiceItems: [{ id: "ii-1", invoiceId: "inv-1", sortOrder: 0, productId: "p-1", quantity: 10, unitPrice: 100000, lineTotal: 1000000 }],
    inventory: [{ id: "inv-row-1", productId: "p-1", warehouseId: "wh-1", qty: 5, damagedQty: 0, avgCostP: 90000 }],
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
    "purchaseItems", "customerReturnItems", "supplierReturnItems", "stockMovements", "stockDocs", "stockDocItems", "orders", "orderItems",
    "expenses", "landedCosts", "landedCostExpenses", "inventoryCostAdjust", "employees", "salaryPayments", "millingJobItems",
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
