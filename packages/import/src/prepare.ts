import { createHash } from "node:crypto";
import type {
  accountAdjustments,
  companyProfile,
  customers,
  invoiceItems,
  invoices,
  millingJobs,
  paymentAllocations,
  payments,
  products,
  purchaseItems,
  purchases,
  regions,
  returns,
  sequences,
  stockLevels,
  stockMovements,
  suppliers,
  warehouses,
} from "@farooq/db";
import {
  custLine,
  invoiceLines,
  invoiceMemo,
  invoicePosts,
  INVOICE_REF_TYPES,
  INVOICE_SOURCE,
  MOVEMENT_KINDS,
  MOVEMENT_REF_TYPES,
  paymentLines,
  paymentMemo,
  paymentReversalMemo,
  plainLine as plain,
  purchaseLines,
  purchaseMemo,
  purchasePosts,
  PURCHASE_SOURCE,
  reversedLines,
  supLine,
  PAYMENT_REVERSAL_SOURCE,
  PAYMENT_SOURCE,
  PURCHASE_REF_TYPES,
  STOCK_BUCKETS,
  type AccountCode,
  type JournalLineDraft,
} from "@farooq/db";
import { ALLOWED_STATUS } from "./classification.js";
import { checkCompanyDoc } from "./company.js";
import {
  checkClassification,
  checkEnvelope,
  ImportError,
  integer,
  isoDate,
  oneOf,
  optBool,
  optIsoDate,
  optNumber,
  optOneOf,
  optPaisa,
  optStr,
  optTimestamp,
  paisa,
  qtyMilli,
  reqStr,
  rupeesPaisa,
  where,
  type Backup,
  type Doc,
} from "./validate.js";

/* ── deterministic ids ────────────────────────────────────────────────────
   A row's id is a UUIDv5 of "<store>:<legacy id>", so re-importing the same backup reproduces the same ids
   (idempotency) and cross-references can be wired in memory before anything touches the database. */
const NAMESPACE = "6f2b6a5e-3d1c-4b8a-9c57-2e0f1d4a7b90";

export function uuidV5(name: string): string {
  const hash = createHash("sha1").update(Buffer.from(NAMESPACE.replace(/-/g, ""), "hex")).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ── journal model ─────────────────────────────────────────────────────── */

/* The line/account model and the payment posting shapes live in @farooq/db (`ledger.ts`) so the importer and
   the live PaymentsService post identically; re-exported here for the importer's own modules. */
export type { AccountCode, JournalLineDraft };

export interface JournalDraft {
  id: string;
  date: string;
  memo: string;
  sourceType: string;
  sourceId: string;
  /** Legacy createdAt when the document has one (statement order depends on it); otherwise the DB default. */
  createdAt: Date | null;
  lines: JournalLineDraft[];
}

export interface Prepared {
  exportedAt: string;
  /** Documents per store in the backup (every store, including deferred/ignored). */
  storeCounts: Record<string, number>;
  rows: {
    regions: (typeof regions.$inferInsert)[];
    warehouses: (typeof warehouses.$inferInsert)[];
    products: (typeof products.$inferInsert)[];
    customers: (typeof customers.$inferInsert)[];
    suppliers: (typeof suppliers.$inferInsert)[];
    invoices: (typeof invoices.$inferInsert)[];
    invoiceItems: (typeof invoiceItems.$inferInsert)[];
    stockLevels: (typeof stockLevels.$inferInsert)[];
    stockMovements: (typeof stockMovements.$inferInsert)[];
    purchases: (typeof purchases.$inferInsert)[];
    purchaseItems: (typeof purchaseItems.$inferInsert)[];
    payments: (typeof payments.$inferInsert)[];
    paymentAllocations: (typeof paymentAllocations.$inferInsert)[];
    returns: (typeof returns.$inferInsert)[];
    accountAdjustments: (typeof accountAdjustments.$inferInsert)[];
    millingJobs: (typeof millingJobs.$inferInsert)[];
    companyProfile: (typeof companyProfile.$inferInsert)[];
    sequences: (typeof sequences.$inferInsert)[];
  };
  journal: JournalDraft[];
  /** Numbers of the invoices the old app's data migration made (`migrated: true`): stock taken without SALE_OUT movements. */
  migratedInvoices: string[];
  /** Numbers of the purchases the old app's data migration made (`migrated: true`; 02-services.js ~2216). */
  migratedPurchases: string[];
  /** Non-fatal observations (e.g. a REFUND return with no matching cash payment). */
  warnings: string[];
}

type Ids = Map<string, string>;

/**
 * The Prices-panel fields of a product, mirroring the legacy `Prices.of` (21-settings.js) exactly:
 *   buy / sell / extra   the `...P` paisa field when it is set (even 0), else the legacy rupee field when truthy, else never set
 *   min                  `minSellP` when truthy, else `min` (rupees) when truthy
 *   wholesale / retail   `wholesaleP` / `retailP` when truthy
 *   discountPct / taxPct / reorder   the number as it is
 * "Never set" is null here (the legacy shows 0). `Prices.of` also falls back to an average cost derived from purchases for
 * `buy` — derived data, not stored (M4). The rupee fields go through the strict parser (2 decimals at most).
 */
function productPrices(d: Doc) {
  const setP = (pKey: string, rupeeKey: string): number | null => {
    if (d[pKey] !== undefined && d[pKey] !== null) return paisa("products", d, pKey);
    return d[rupeeKey] ? rupeesPaisa("products", d, rupeeKey) : null;
  };
  const truthyP = (pKey: string, rupeeKey?: string): number | null => {
    if (d[pKey]) return paisa("products", d, pKey);
    return rupeeKey && d[rupeeKey] ? rupeesPaisa("products", d, rupeeKey) : null;
  };
  return {
    buyP: setP("buyP", "buy"),
    sellP: setP("sellP", "sell"),
    extraP: setP("extraP", "extra"),
    minSellP: truthyP("minSellP", "min"),
    wholesaleP: truthyP("wholesaleP"),
    retailP: truthyP("retailP"),
    discountPct: optNumber("products", d, "discountPct"),
    taxPct: optNumber("products", d, "taxPct"),
    reorder: optNumber("products", d, "reorder"),
  };
}

const plusMs = (d: Date | null, ms: number): Date | null => (d ? new Date(d.getTime() + ms) : null);

function register(store: string, ids: Ids, doc: Doc, key = "id"): string {
  const legacy = doc[key];
  if (typeof legacy !== "string" || legacy === "") throw new ImportError(`${where(store, doc)}.${key}: expected a non-empty string id`);
  if (ids.has(legacy)) throw new ImportError(`Duplicate legacy id in '${store}': ${legacy}`);
  const id = uuidV5(`${store}:${legacy}`);
  ids.set(legacy, id);
  return id;
}

function resolve(store: string, doc: Doc, key: string, target: string, ids: Ids): string {
  const v = doc[key];
  if (typeof v !== "string" || v === "") throw new ImportError(`${where(store, doc)}.${key}: expected a ${target} id`);
  const id = ids.get(v);
  if (!id) throw new ImportError(`${where(store, doc)}.${key}: dangling reference — no ${target} with id ${v}`);
  return id;
}

/**
 * Pure: validates the whole backup and maps it to table rows + journal entries. Touches no database, so any
 * ImportError leaves the database exactly as it was.
 *
 * ── The posting table (Ledger filters ported exactly — the quirks are deliberate) ─────────────────────────
 *  Invoice                 status not DRAFT/CANCELLED   DR RECEIVABLES(cust) / CR SALES               grandTotal
 *  Payment IN (customer)   status not REVERSED          DR CASH / CR RECEIVABLES(cust)
 *  Payment OUT (customer)  status not REVERSED          DR RECEIVABLES(cust) / CR CASH                (a refund)
 *  Customer return         status not CANCELLED         DR SALES_RETURNS / CR RECEIVABLES(cust)       creditAmount   (DRAFT counts!)
 *  Purchase                status not CANCELLED         DR PURCHASES / CR PAYABLES(supplier)          grandTotal     (DRAFT counts!)
 *  Payment OUT (supplier)  status not REVERSED          DR PAYABLES(supplier) / CR CASH
 *  Supplier return         status not CANCELLED         DR PAYABLES(supplier) / CR PURCHASE_RETURNS   debitAmount    (DRAFT counts!)
 *  Opening balance         openingBalanceP != 0         customer: DR RECEIVABLES / CR OPENING_EQUITY;  supplier: DR OPENING_EQUITY / CR PAYABLES
 *                                                        (a negative opening swaps the sides — same signed effect)
 *  Account adjustment      status not REVERSED          DEBIT: DR RECEIVABLES(cust) / CR ACCOUNT_ADJUSTMENTS;  CREDIT: the reverse
 *  Milling job             status not CANCELLED         NET jobs: issued  DR PAYABLES(mill) / CR MILLING_CLEARING   issuedValue   (if nonzero)
 *                                                                 received DR MILLING_CLEARING / CR PAYABLES(mill) receivedValue (if nonzero)
 *                                                       every job:  fee     DR MILLING_FEES / CR PAYABLES(mill)     feeAmount     (if nonzero)
 *                                                       FEE_ONLY jobs post the fee only, even if issued/received values are nonzero.
 *  REVERSED payment / adjustment: the row is imported with status REVERSED and BOTH the original entry and a
 *  reversing entry (source_type *_REVERSAL, dated like the original so the pair cancels at every date) are
 *  posted. The legacy ledger simply skips them; the net effect is identical, which the fixture proves.
 */
export function prepareImport(raw: unknown): Prepared {
  const backup: Backup = checkEnvelope(raw);

  const storeCounts: Record<string, number> = {};
  for (const [store, docs] of Object.entries(backup.data)) storeCounts[store] = docs.length;

  // Credentials are counted above and then never read: `users` is filtered out before any mapping (non-mutating).
  const data: Record<string, Doc[]> = Object.fromEntries(Object.entries(backup.data).filter(([store]) => store !== "users"));

  checkClassification(data);

  const warnings: string[] = [];
  const rows: Prepared["rows"] = {
    regions: [],
    warehouses: [],
    products: [],
    customers: [],
    suppliers: [],
    invoices: [],
    invoiceItems: [],
    stockLevels: [],
    stockMovements: [],
    purchases: [],
    purchaseItems: [],
    payments: [],
    paymentAllocations: [],
    returns: [],
    accountAdjustments: [],
    millingJobs: [],
    companyProfile: [],
    sequences: [],
  };
  const journal: JournalDraft[] = [];

  const regionIds: Ids = new Map();
  const warehouseIds: Ids = new Map();
  const customerIds: Ids = new Map();
  const supplierIds: Ids = new Map();
  const invoiceIds: Ids = new Map();
  const purchaseIds: Ids = new Map();
  const paymentIds: Ids = new Map();

  const post = (
    sourceType: string,
    sourceId: string,
    date: string,
    memo: string,
    createdAt: Date | null,
    lines: JournalLineDraft[],
  ) => {
    journal.push({ id: uuidV5(`journal:${sourceType}:${sourceId}`), date, memo, sourceType, sourceId, createdAt, lines });
  };
  const swapped = reversedLines;

  /** A signed customer-side amount: positive = DR RECEIVABLES / CR `counter`; negative swaps the sides. */
  const receivableLines = (customerId: string, counter: AccountCode, signedP: number): JournalLineDraft[] => {
    const abs = Math.abs(signedP);
    return signedP >= 0
      ? [custLine(customerId, abs, 0), plain(counter, 0, abs)]
      : [plain(counter, abs, 0), custLine(customerId, 0, abs)];
  };
  /** A signed supplier-side amount: positive = DR `counter` / CR PAYABLES; negative swaps the sides. */
  const payableLines = (supplierId: string, counter: AccountCode, signedP: number): JournalLineDraft[] => {
    const abs = Math.abs(signedP);
    return signedP >= 0
      ? [plain(counter, abs, 0), supLine(supplierId, 0, abs)]
      : [supLine(supplierId, abs, 0), plain(counter, 0, abs)];
  };

  /* ── master data ─────────────────────────────────────────────────────── */

  for (const d of data.regions ?? []) {
    const id = register("regions", regionIds, d);
    rows.regions.push({
      id,
      legacyId: d.id,
      nameEn: reqStr("regions", d, "en"),
      nameUr: optStr("regions", d, "ur"),
      active: optBool("regions", d, "active", true),
      legacyDoc: d,
    });
  }

  for (const d of data.warehouses ?? []) {
    const id = register("warehouses", warehouseIds, d);
    rows.warehouses.push({
      id,
      legacyId: d.id,
      name: reqStr("warehouses", d, "name"),
      active: optBool("warehouses", d, "active", true),
      legacyDoc: d,
    });
  }

  const productIds: Ids = new Map();
  for (const d of data.products ?? []) {
    const id = register("products", productIds, d);
    // Three real products lack `name`: fall back to en, then ur.
    const name = optStr("products", d, "name") ?? optStr("products", d, "en") ?? optStr("products", d, "ur");
    if (!name) throw new ImportError(`${where("products", d)}: no name, en or ur`);
    // Weight: `kg` (the catalogue) first, else `weightKg` (an older import) — both null on some real products.
    const kg = optNumber("products", d, "kg");
    rows.products.push({
      id,
      legacyId: d.id,
      name,
      category: optStr("products", d, "category") ?? optStr("products", d, "cat"),
      unit: optStr("products", d, "unit"),
      active: optBool("products", d, "active", true),
      nameUr: optStr("products", d, "ur"),
      nameEn: optStr("products", d, "en"),
      brand: optStr("products", d, "brand"),
      brandEn: optStr("products", d, "brandEn"),
      weightKg: kg ?? optNumber("products", d, "weightKg"),
      sku: optStr("products", d, "sku"),
      barcode: optStr("products", d, "barcode"),
      ...productPrices(d),
      legacyDoc: d,
    });
  }

  for (const d of data.customers ?? []) {
    const id = register("customers", customerIds, d);
    const regionKey = optStr("customers", d, "region");
    const createdAt = optTimestamp("customers", d, "createdAt");
    rows.customers.push({
      id,
      legacyId: d.id,
      shopName: reqStr("customers", d, "sh"),
      ownerName: optStr("customers", d, "ow"),
      phone: optStr("customers", d, "ph"),
      regionId: regionKey ? resolve("customers", d, "region", "region", regionIds) : null,
      creditLimitP: 0, // `lim` is kept in legacy_doc: null in every real row, unit unverified (M2 decides)
      openingBalanceP: paisa("customers", d, "openingBalanceP", { signed: true, optional: true }),
      openingBalanceDate: optIsoDate("customers", d, "openingBalanceDate"),
      isCashCounter: optBool("customers", d, "isCashCounter", false),
      legacyCode: optStr("customers", d, "legacyCode"),
      active: optBool("customers", d, "active", true),
      ...(createdAt ? { createdAt } : {}),
      legacyDoc: d,
    });
  }

  for (const d of data.suppliers ?? []) {
    const id = register("suppliers", supplierIds, d);
    const createdAt = optTimestamp("suppliers", d, "createdAt");
    rows.suppliers.push({
      id,
      legacyId: d.id,
      companyName: reqStr("suppliers", d, "co"),
      phone: optStr("suppliers", d, "ph"),
      openingBalanceP: paisa("suppliers", d, "openingBalanceP", { signed: true, optional: true }),
      openingBalanceDate: optIsoDate("suppliers", d, "openingBalanceDate"),
      active: optBool("suppliers", d, "active", true),
      ...(createdAt ? { createdAt } : {}),
      legacyDoc: d,
    });
  }

  // Opening balances. Dated openingBalanceDate, else 2000-01-01 (as the legacy code does). No legacy createdAt.
  for (const c of rows.customers) {
    if (c.openingBalanceP) {
      post("CUSTOMER_OPENING", c.id!, c.openingBalanceDate ?? "2000-01-01", "Opening balance", null, receivableLines(c.id!, "OPENING_EQUITY", c.openingBalanceP));
    }
  }
  for (const s of rows.suppliers) {
    if (s.openingBalanceP) {
      post("SUPPLIER_OPENING", s.id!, s.openingBalanceDate ?? "2000-01-01", "Opening balance", null, payableLines(s.id!, "OPENING_EQUITY", s.openingBalanceP));
    }
  }

  /* ── invoices / purchases ────────────────────────────────────────────── */

  const invoiceNumbers = new Map<string, string>(); // invoice number -> legacy id (a number identifies one invoice)
  const migratedInvoices: string[] = [];

  for (const d of data.invoices ?? []) {
    const id = register("invoices", invoiceIds, d);
    const customerId = resolve("invoices", d, "customerId", "customer", customerIds);
    const date = isoDate("invoices", d, "invoiceDate");
    const totalP = paisa("invoices", d, "grandTotal");
    const status = oneOf("invoices", d, "status", ALLOWED_STATUS.invoices);
    const createdAt = optTimestamp("invoices", d, "createdAt");
    const number = optStr("invoices", d, "invoiceNumber");
    if (number !== null) {
      const clash = invoiceNumbers.get(number);
      if (clash) throw new ImportError(`${where("invoices", d)}.invoiceNumber: ${number} is already the number of invoice ${clash} — a number identifies one invoice`);
      invoiceNumbers.set(number, d.id);
    }
    const warehouseKey = optStr("invoices", d, "warehouseId");
    const regionKey = optStr("invoices", d, "regionId");
    const updatedAt = optTimestamp("invoices", d, "updatedAt");
    const migrated = optBool("invoices", d, "migrated", false);
    if (migrated) migratedInvoices.push(number ?? d.id);
    rows.invoices.push({
      id,
      legacyId: d.id,
      invoiceNumber: number,
      customerId,
      date,
      totalP,
      status,
      ...(createdAt ? { createdAt } : {}),
      invoiceType: optOneOf("invoices", d, "invoiceType", ["SALE"] as const) ?? "SALE",
      dueDate: optIsoDate("invoices", d, "dueDate"),
      warehouseId: warehouseKey ? resolve("invoices", d, "warehouseId", "warehouse", warehouseIds) : null,
      salesperson: optStr("invoices", d, "salesperson"),
      subtotalP: paisa("invoices", d, "subtotal", { optional: true }),
      itemDiscountsP: paisa("invoices", d, "itemDiscounts", { optional: true }),
      invoiceDiscountP: paisa("invoices", d, "invoiceDiscount", { optional: true }),
      taxP: paisa("invoices", d, "taxAmount", { optional: true }),
      freightP: paisa("invoices", d, "freightAmount", { optional: true }),
      loadingP: paisa("invoices", d, "loadingAmount", { optional: true }),
      otherChargesP: paisa("invoices", d, "otherCharges", { optional: true }),
      paymentMethod: optStr("invoices", d, "paymentMethod"),
      referenceNo: optStr("invoices", d, "referenceNo"),
      notes: optStr("invoices", d, "notes"),
      description: optStr("invoices", d, "description"),
      previousBalanceP: paisa("invoices", d, "previousBalance", { signed: true, optional: true }),
      totalQtyMilli: qtyMilli("invoices", d, "totalQty", { optional: true }),
      lineCount: d.lineCount === undefined || d.lineCount === null ? 0 : integer("invoices", d, "lineCount"),
      stockApplied: optBool("invoices", d, "stockApplied", false),
      migrated,
      revision: d.revision === undefined || d.revision === null ? 0 : integer("invoices", d, "revision"),
      ...(updatedAt ? { updatedAt } : {}),
      confirmedAt: optTimestamp("invoices", d, "confirmedAt"),
      cancelledAt: optTimestamp("invoices", d, "cancelledAt"),
      cancelReason: optStr("invoices", d, "cancelReason"),
      saleOrderId: optStr("invoices", d, "saleOrderId"),
      orderNumber: optStr("invoices", d, "orderNumber"),
      dispatchNumber: optStr("invoices", d, "dispatchNumber"),
      customerCodeSnapshot: optStr("invoices", d, "customerCodeSnapshot"),
      customerNameSnapshot: optStr("invoices", d, "customerNameSnapshot"),
      shopNameSnapshot: optStr("invoices", d, "shopNameSnapshot"),
      contactPersonSnapshot: optStr("invoices", d, "contactPersonSnapshot"),
      mobileSnapshot: optStr("invoices", d, "mobileSnapshot"),
      whatsappSnapshot: optStr("invoices", d, "whatsappSnapshot"),
      addressSnapshot: optStr("invoices", d, "addressSnapshot"),
      regionId: regionKey ? resolve("invoices", d, "regionId", "region", regionIds) : null,
      regionSnapshot: optStr("invoices", d, "regionSnapshot"),
      marketSnapshot: optStr("invoices", d, "marketSnapshot"),
      warehouseSnapshot: optStr("invoices", d, "warehouseSnapshot"),
      legacyDoc: d,
    });
    // A skipped (DRAFT/CANCELLED) invoice is still imported as a row, just with no journal entry. The posting shape
    // (DR RECEIVABLES / CR SALES) is the shared builder's — the same one the live invoice service will use (S7).
    if (invoicePosts(status)) {
      post(INVOICE_SOURCE, id, date, invoiceMemo(number), createdAt, invoiceLines(customerId, totalP));
    }
  }

  const purchaseNumbers = new Map<string, string>(); // purchase number -> legacy id (a number identifies one purchase)
  const migratedPurchases: string[] = [];
  for (const d of data.purchases ?? []) {
    const id = register("purchases", purchaseIds, d);
    const supplierId = resolve("purchases", d, "supplierId", "supplier", supplierIds);
    const date = isoDate("purchases", d, "purchaseDate");
    const totalP = paisa("purchases", d, "grandTotal");
    const status = oneOf("purchases", d, "status", ALLOWED_STATUS.purchases);
    const createdAt = optTimestamp("purchases", d, "createdAt");
    const number = optStr("purchases", d, "purchaseNumber");
    if (number !== null) {
      const clash = purchaseNumbers.get(number);
      if (clash) throw new ImportError(`${where("purchases", d)}.purchaseNumber: ${number} is already the number of purchase ${clash} — a number identifies one purchase`);
      purchaseNumbers.set(number, d.id);
    }
    const warehouseKey = optStr("purchases", d, "warehouseId");
    const updatedAt = optTimestamp("purchases", d, "updatedAt");
    const migrated = optBool("purchases", d, "migrated", false);
    if (migrated) migratedPurchases.push(number ?? d.id);
    rows.purchases.push({
      id,
      legacyId: d.id,
      purchaseNumber: number,
      supplierId,
      date,
      totalP,
      status,
      ...(createdAt ? { createdAt } : {}),
      supplierNameSnapshot: optStr("purchases", d, "supplierNameSnapshot"),
      supplierInvoiceNo: optStr("purchases", d, "supplierInvoiceNo"),
      warehouseId: warehouseKey ? resolve("purchases", d, "warehouseId", "warehouse", warehouseIds) : null,
      warehouseSnapshot: optStr("purchases", d, "warehouseSnapshot"),
      vehicleNo: optStr("purchases", d, "vehicleNo"),
      driver: optStr("purchases", d, "driver"),
      deliveryRef: optStr("purchases", d, "deliveryRef"),
      subtotalP: paisa("purchases", d, "subtotal", { optional: true }),
      discountAmountP: paisa("purchases", d, "discountAmount", { optional: true }),
      taxP: paisa("purchases", d, "taxAmount", { optional: true }),
      freightP: paisa("purchases", d, "freightAmount", { optional: true }),
      loadingP: paisa("purchases", d, "loadingAmount", { optional: true }),
      otherChargesP: paisa("purchases", d, "otherCharges", { optional: true }),
      totalQtyMilli: qtyMilli("purchases", d, "totalQty", { optional: true }),
      orderedQtyMilli: qtyMilli("purchases", d, "orderedQty", { optional: true }),
      receivedQtyMilli: qtyMilli("purchases", d, "receivedQty", { optional: true }),
      lineCount: d.lineCount === undefined || d.lineCount === null ? 0 : integer("purchases", d, "lineCount"),
      notes: optStr("purchases", d, "notes"),
      description: optStr("purchases", d, "description"),
      stockApplied: optBool("purchases", d, "stockApplied", false),
      migrated,
      revision: d.revision === undefined || d.revision === null ? 0 : integer("purchases", d, "revision"),
      ...(updatedAt ? { updatedAt } : {}),
      clientOpId: optStr("purchases", d, "clientOpId"),
      legacyDoc: d,
    });
    // Everything except CANCELLED is in the ledger (a DRAFT counts); the posting shape is the shared builder's, the one S12 will use.
    if (purchasePosts(status)) {
      post(PURCHASE_SOURCE, id, date, purchaseMemo(number), createdAt, purchaseLines(supplierId, totalP));
    }
  }

  /* ── invoice lines + stock (S6) ──────────────────────────────────────── */

  const itemIds: Ids = new Map();
  for (const d of data.invoiceItems ?? []) {
    const id = register("invoiceItems", itemIds, d);
    const invoiceId = resolve("invoiceItems", d, "invoiceId", "invoice", invoiceIds); // a line on an invoice that is not in the backup aborts
    const productId = resolve("invoiceItems", d, "productId", "product", productIds);
    const warehouseId = resolve("invoiceItems", d, "warehouseId", "warehouse", warehouseIds);
    const qty = qtyMilli("invoiceItems", d, "quantity", { sign: "positive" });
    const unitPriceP = paisa("invoiceItems", d, "unitPrice");
    const discountP = paisa("invoiceItems", d, "discount", { optional: true });
    const returnedQtyMilli = qtyMilli("invoiceItems", d, "returnedQty", { optional: true });
    if (1000 * discountP > unitPriceP * qty + 500) {
      throw new ImportError(`${where("invoiceItems", d)}.discount: ${discountP} paisa is more than the line's gross (${unitPriceP} paisa x ${qty / 1000})`);
    }
    if (returnedQtyMilli > qty) throw new ImportError(`${where("invoiceItems", d)}.returnedQty: ${returnedQtyMilli / 1000} is more than the quantity sold (${qty / 1000})`);
    rows.invoiceItems.push({
      id,
      legacyId: d.id,
      invoiceId,
      sortOrder: d.sortOrder === undefined || d.sortOrder === null ? 0 : integer("invoiceItems", d, "sortOrder"),
      productId,
      warehouseId,
      descriptionSnapshot: optStr("invoiceItems", d, "descriptionSnapshot"),
      descriptionEnSnapshot: optStr("invoiceItems", d, "descriptionEnSnapshot"),
      brandSnapshot: optStr("invoiceItems", d, "brandSnapshot"),
      categorySnapshot: optStr("invoiceItems", d, "categorySnapshot"),
      packageSnapshot: optStr("invoiceItems", d, "packageSnapshot"),
      skuSnapshot: optStr("invoiceItems", d, "skuSnapshot"),
      unit: optStr("invoiceItems", d, "unit") ?? "Bag",
      qtyMilli: qty,
      unitPriceP,
      discountP,
      taxP: paisa("invoiceItems", d, "tax", { optional: true }),
      lineTotalP: paisa("invoiceItems", d, "lineTotal"),
      costSnapshotP: optPaisa("invoiceItems", d, "costSnapshot"),
      returnedQtyMilli,
      batchNo: optStr("invoiceItems", d, "batchNo"),
      notes: optStr("invoiceItems", d, "notes"),
      legacyDoc: d,
    });
  }

  /* ── purchase lines (S11) ────────────────────────────────────────────── */

  // The header's godown is only a default: the legacy stores the godown on every line, and stock moves in that one.
  const headerWarehouse = new Map<string, string | null>((data.purchases ?? []).map((p) => [p.id, typeof p.warehouseId === "string" && p.warehouseId ? p.warehouseId : null]));
  const purchaseItemIds: Ids = new Map();
  for (const d of data.purchaseItems ?? []) {
    const id = register("purchaseItems", purchaseItemIds, d);
    const purchaseId = resolve("purchaseItems", d, "purchaseId", "purchase", purchaseIds); // a line on a purchase that is not in the backup aborts
    const productId = resolve("purchaseItems", d, "productId", "product", productIds);
    const lineWarehouse = d.warehouseId === undefined || d.warehouseId === null || d.warehouseId === "" ? headerWarehouse.get(d.purchaseId) : d.warehouseId;
    if (!lineWarehouse) throw new ImportError(`${where("purchaseItems", d)}.warehouseId: the line has no godown and neither has its purchase`);
    const warehouseId = resolve("purchaseItems", { ...d, warehouseId: lineWarehouse }, "warehouseId", "warehouse", warehouseIds);
    const qty = qtyMilli("purchaseItems", d, "quantity", { sign: "positive" });
    // `orderedQty` is always the same figure as `quantity` in what the legacy writes; a line where they differ is not understood, so it aborts.
    if (d.orderedQty !== undefined && d.orderedQty !== null && qtyMilli("purchaseItems", d, "orderedQty") !== qty) {
      throw new ImportError(`${where("purchaseItems", d)}.orderedQty: ${d.orderedQty} differs from the quantity ${d.quantity} — the legacy always writes the same figure in both`);
    }
    // receivedQty ABSENT = the whole line arrived (`receivedQty === undefined ? quantity : receivedQty` all through the legacy); 0 = nothing arrived.
    const received = d.receivedQty === undefined ? qty : qtyMilli("purchaseItems", d, "receivedQty");
    const unitPriceP = paisa("purchaseItems", d, "unitPrice");
    const discountP = paisa("purchaseItems", d, "discount", { optional: true });
    if (1000 * discountP > unitPriceP * qty + 500) {
      throw new ImportError(`${where("purchaseItems", d)}.discount: ${discountP} paisa is more than the line's gross (${unitPriceP} paisa x ${qty / 1000})`);
    }
    rows.purchaseItems.push({
      id,
      legacyId: d.id,
      purchaseId,
      sortOrder: d.sortOrder === undefined || d.sortOrder === null ? 0 : integer("purchaseItems", d, "sortOrder"),
      productId,
      warehouseId,
      descriptionSnapshot: optStr("purchaseItems", d, "descriptionSnapshot"),
      descriptionEnSnapshot: optStr("purchaseItems", d, "descriptionEnSnapshot"),
      brandSnapshot: optStr("purchaseItems", d, "brandSnapshot"),
      packageSnapshot: optStr("purchaseItems", d, "packageSnapshot"),
      unit: optStr("purchaseItems", d, "unit") ?? "Bag",
      qtyMilli: qty,
      receivedQtyMilli: received,
      returnedQtyMilli: qtyMilli("purchaseItems", d, "returnedQty", { optional: true }),
      unitPriceP,
      discountP,
      taxP: paisa("purchaseItems", d, "tax", { optional: true }),
      lineTotalP: paisa("purchaseItems", d, "lineTotal"),
      goodsUnitCostP: optPaisa("purchaseItems", d, "goodsUnitCost"),
      chargeShareP: optPaisa("purchaseItems", d, "chargeShare"),
      landedUnitCostP: optPaisa("purchaseItems", d, "landedUnitCost"),
      operationalShareP: optPaisa("purchaseItems", d, "operationalShare"),
      batchNo: optStr("purchaseItems", d, "batchNo"),
      notes: optStr("purchaseItems", d, "notes"),
      legacyDoc: d,
    });
  }

  // Stock levels: one legacy `inventory` row (qty + damagedQty + costs) becomes a `stock` row and, when there is damaged
  // stock, a `damaged` row. avgCostP / lastCostP are carried verbatim on the stock row (read by costOf; M3-M4 maintain them).
  const levelSeen = new Set<string>();
  for (const raw of data.inventory ?? []) {
    const d: Doc = { ...raw, id: raw.id ?? `${raw.productId}|${raw.warehouseId}` }; // `id` is the `<product>|<warehouse>` key: only used to name a row in an error
    const productId = resolve("inventory", d, "productId", "product", productIds);
    const warehouseId = resolve("inventory", d, "warehouseId", "warehouse", warehouseIds);
    const pair = `${productId}|${warehouseId}`;
    if (levelSeen.has(pair)) throw new ImportError(`Duplicate 'inventory' row for product ${d.productId} in warehouse ${d.warehouseId}`);
    levelSeen.add(pair);
    const named = d;
    rows.stockLevels.push({
      productId,
      warehouseId,
      bucket: "stock",
      qtyMilli: qtyMilli("inventory", named, "qty", { sign: "any" }),
      avgCostP: paisa("inventory", named, "avgCostP", { optional: true }),
      lastCostP: paisa("inventory", named, "lastCostP", { optional: true }),
    });
    const damagedMilli = qtyMilli("inventory", named, "damagedQty", { sign: "any", optional: true });
    if (damagedMilli !== 0) rows.stockLevels.push({ productId, warehouseId, bucket: "damaged", qtyMilli: damagedMilli, avgCostP: 0, lastCostP: 0 });
  }

  // Movements point at their document by the legacy free-text `ref` (the document's number). Invoices and purchases are
  // in the database, so those resolve to a real id (and an unresolvable one aborts); every other type is carried by name.
  const purchasesByNumber = new Map<string, string[]>();
  for (const p of rows.purchases) {
    if (p.purchaseNumber) purchasesByNumber.set(p.purchaseNumber, [...(purchasesByNumber.get(p.purchaseNumber) ?? []), p.id!]);
  }
  const invoiceByRef = (ref: string): string | undefined => {
    const legacy = invoiceNumbers.get(ref);
    return invoiceIds.get(legacy ?? ref); // the number, else (a draft that never had one) the legacy id — the old edit path wrote either
  };
  const movementIds: Ids = new Map();
  for (const d of data.stockMovements ?? []) {
    const id = register("stockMovements", movementIds, d);
    const productId = resolve("stockMovements", d, "productId", "product", productIds);
    const warehouseId = resolve("stockMovements", d, "warehouseId", "warehouse", warehouseIds);
    const kind = oneOf("stockMovements", d, "kind", MOVEMENT_KINDS);
    const bucket = d.bucket === undefined || d.bucket === null || d.bucket === "" ? "stock" : oneOf("stockMovements", d, "bucket", STOCK_BUCKETS);
    const refType = d.refType === undefined || d.refType === null ? "" : oneOf("stockMovements", d, "refType", MOVEMENT_REF_TYPES);
    const ref = optStr("stockMovements", d, "ref");
    const delta = qtyMilli("stockMovements", d, "qtyDelta", { sign: "any" });
    if (delta === 0) throw new ImportError(`${where("stockMovements", d)}.qtyDelta: a movement of zero is not a movement`);
    // S14 (old repo b2b0778, StockDocs.editReceive): an edited Add-stock receipt takes each old line back OUT (qty < 0) at that
    // line's cost, written as `unitCostP: o.unitCostP || 0` — so the field is always there (0 = the old line had no cost). One
    // that is missing or positive would corrupt `carriedCost`, so it aborts the import instead of being guessed at.
    if (kind === "RECEIPT_EDIT_OUT") {
      if (delta > 0) throw new ImportError(`${where("stockMovements", d)}.qtyDelta: a RECEIPT_EDIT_OUT takes bags back out of stock, so it must be negative (got ${d.qtyDelta})`);
      if (d.unitCostP === undefined || d.unitCostP === null) {
        throw new ImportError(`${where("stockMovements", d)}.unitCostP: a RECEIPT_EDIT_OUT carries the old line's cost (0 when it had none) — the field is missing`);
      }
    }
    let sourceType: string | null = refType || null;
    let sourceId: string | null = null;
    if ((INVOICE_REF_TYPES as readonly string[]).includes(refType)) {
      sourceType = "INVOICE";
      sourceId = (ref && invoiceByRef(ref)) || null;
      if (!sourceId) throw new ImportError(`${where("stockMovements", d)}.ref: dangling reference — no invoice numbered ${JSON.stringify(ref)} (refType ${refType})`);
    } else if ((PURCHASE_REF_TYPES as readonly string[]).includes(refType)) {
      sourceType = "PURCHASE";
      const hits = ref ? (purchasesByNumber.get(ref) ?? []) : [];
      if (hits.length !== 1) {
        throw new ImportError(`${where("stockMovements", d)}.ref: ${hits.length === 0 ? "dangling reference — no" : "ambiguous — more than one"} purchase numbered ${JSON.stringify(ref)} (refType ${refType})`);
      }
      sourceId = hits[0]!;
    }
    const createdAt = optTimestamp("stockMovements", d, "createdAt");
    const unitCost = paisa("stockMovements", d, "unitCostP", { optional: true });
    rows.stockMovements.push({
      id,
      legacyId: d.id,
      date: isoDate("stockMovements", d, "date"),
      ...(createdAt ? { createdAt } : {}),
      productId,
      warehouseId,
      kind,
      bucket,
      qtyDeltaMilli: delta,
      unitCostP: unitCost > 0 ? unitCost : null, // legacy 0 = "no cost recorded"
      ref,
      refType: refType || null,
      sourceType,
      sourceId,
      note: optStr("stockMovements", d, "note"),
      legacyDoc: d,
    });
  }

  /* ── payments ────────────────────────────────────────────────────────── */

  const receiptSeen = new Set<string>();
  const paymentRefs: { id: string; direction: string; partyType: string; partyId: string; reference: string | null; note: string | null; status: string }[] = [];
  for (const d of data.payments ?? []) {
    const id = register("payments", paymentIds, d);
    const direction = oneOf("payments", d, "direction", ["IN", "OUT"] as const);
    const partyType = oneOf("payments", d, "partyType", ["CUSTOMER", "SUPPLIER"] as const);
    if (direction === "IN" && partyType !== "CUSTOMER") {
      // The legacy customer filter (direction==='IN' || partyType==='CUSTOMER') would count this against a
      // customer id while the supplier filter ignores it: ambiguous, so refuse rather than guess.
      throw new ImportError(`${where("payments", d)}: direction IN with partyType ${partyType} is not something the legacy app writes`);
    }
    const partyId = resolve("payments", d, "partyId", partyType.toLowerCase(), partyType === "CUSTOMER" ? customerIds : supplierIds);
    const receiptNumber = reqStr("payments", d, "receiptNumber");
    if (receiptSeen.has(receiptNumber)) throw new ImportError(`Duplicate receipt number in 'payments': ${receiptNumber}`);
    receiptSeen.add(receiptNumber);
    const amountP = paisa("payments", d, "amount");
    const status = oneOf("payments", d, "status", ALLOWED_STATUS.payments);
    const paymentDate = isoDate("payments", d, "paymentDate");
    const createdAt = optTimestamp("payments", d, "createdAt");
    const reversedAt = optTimestamp("payments", d, "reversedAt");
    const reference = optStr("payments", d, "reference");
    const note = optStr("payments", d, "note");
    rows.payments.push({
      id,
      legacyId: d.id,
      direction,
      partyType,
      partyId,
      isRefund: optBool("payments", d, "isRefund", false),
      amountP,
      method: optStr("payments", d, "method"),
      reference,
      note,
      paymentDate,
      status,
      receiptNumber,
      receivedBy: optStr("payments", d, "receivedBy"),
      partyNameSnapshot: optStr("payments", d, "partyNameSnapshot"),
      partyOwnerSnapshot: optStr("payments", d, "partyOwnerSnapshot"),
      regionSnapshot: optStr("payments", d, "regionSnapshot"),
      ...(createdAt ? { createdAt } : {}),
      reversedAt: status === "REVERSED" ? reversedAt : null,
      reverseReason: optStr("payments", d, "reverseReason"),
      legacyDoc: d,
    });
    paymentRefs.push({ id, direction, partyType, partyId, reference, note, status });

    // The posting shapes (IN / refund / supplier payment) are the shared builder's — the same one the live service uses.
    const lines = paymentLines({ direction, partyType, partyId, amountP });
    const memoOf = { direction, partyType, receiptNumber };
    post(PAYMENT_SOURCE, id, paymentDate, paymentMemo(memoOf), createdAt, lines);
    if (status === "REVERSED") {
      post(PAYMENT_REVERSAL_SOURCE, id, paymentDate, paymentReversalMemo(receiptNumber), reversedAt ?? createdAt, swapped(lines));
    }
  }

  const allocationIds: Ids = new Map();
  for (const d of data.paymentAllocations ?? []) {
    const id = register("paymentAllocations", allocationIds, d);
    const invoiceKey = optStr("paymentAllocations", d, "invoiceId");
    const purchaseKey = optStr("paymentAllocations", d, "purchaseId");
    if (!invoiceKey === !purchaseKey) {
      throw new ImportError(`${where("paymentAllocations", d)}: exactly one of invoiceId / purchaseId must be set`);
    }
    const createdAt = optTimestamp("paymentAllocations", d, "createdAt");
    rows.paymentAllocations.push({
      id,
      legacyId: d.id,
      paymentId: resolve("paymentAllocations", d, "paymentId", "payment", paymentIds),
      invoiceId: invoiceKey ? resolve("paymentAllocations", d, "invoiceId", "invoice", invoiceIds) : null,
      purchaseId: purchaseKey ? resolve("paymentAllocations", d, "purchaseId", "purchase", purchaseIds) : null,
      amountP: paisa("paymentAllocations", d, "amount"),
      ...(createdAt ? { createdAt } : {}),
    });
  }

  /* ── returns ─────────────────────────────────────────────────────────── */

  const returnIds: Ids = new Map();
  const TREATMENTS = ["ADJUST_OUTSTANDING_BALANCE", "CUSTOMER_CREDIT", "REFUND", "REPLACEMENT"] as const;
  for (const d of data.customerReturns ?? []) {
    const id = register("customerReturns", returnIds, d);
    const customerId = resolve("customerReturns", d, "customerId", "customer", customerIds);
    const date = isoDate("customerReturns", d, "returnDate");
    const totalP = paisa("customerReturns", d, "creditAmount");
    const status = oneOf("customerReturns", d, "status", ALLOWED_STATUS.customerReturns);
    const treatment = optOneOf("customerReturns", d, "treatment", TREATMENTS);
    const number = optStr("customerReturns", d, "returnNumber");
    const createdAt = optTimestamp("customerReturns", d, "createdAt");
    // The invoice the goods came back against (feeds `Invoices.outstanding`). Blank = a return with no invoice.
    const invoiceKey = optStr("customerReturns", d, "invoiceId");
    const invoiceId = invoiceKey ? resolve("customerReturns", d, "invoiceId", "invoice", invoiceIds) : null;

    // The legacy app links a REFUND return to its cash payment only by reference + note prefix (editAmountCheck).
    let refundPaymentId: string | null = null;
    if (treatment === "REFUND" && totalP > 0) {
      const matches = paymentRefs.filter(
        (p) => p.partyType === "CUSTOMER" && p.direction === "OUT" && p.partyId === customerId && number !== null && p.reference === number && /^Refund against return /.test(p.note ?? ""),
      );
      if (matches.length === 1) refundPaymentId = matches[0]!.id;
      else warnings.push(`customerReturns[id=${d.id}]: REFUND treatment but ${matches.length} matching cash payments (expected 1); refund_payment_id left empty`);
    }
    rows.returns.push({ id, legacyId: d.id, kind: "CUSTOMER", partyId: customerId, invoiceId, returnNumber: number, date, totalP, status, treatment, refundPaymentId, ...(createdAt ? { createdAt } : {}), legacyDoc: d });
    // Quirk: DRAFT returns already count; only CANCELLED is excluded.
    if (status !== "CANCELLED") {
      post("CUSTOMER_RETURN", id, date, `Customer return ${number ?? ""}`.trim(), createdAt, [plain("SALES_RETURNS", totalP, 0), custLine(customerId, 0, totalP)]);
    }
  }

  for (const d of data.supplierReturns ?? []) {
    const id = register("supplierReturns", returnIds, d);
    const supplierId = resolve("supplierReturns", d, "supplierId", "supplier", supplierIds);
    const date = isoDate("supplierReturns", d, "returnDate");
    const totalP = paisa("supplierReturns", d, "debitAmount");
    const status = oneOf("supplierReturns", d, "status", ALLOWED_STATUS.supplierReturns);
    const number = optStr("supplierReturns", d, "returnNumber");
    const createdAt = optTimestamp("supplierReturns", d, "createdAt");
    rows.returns.push({ id, legacyId: d.id, kind: "SUPPLIER", partyId: supplierId, invoiceId: null, returnNumber: number, date, totalP, status, treatment: null, refundPaymentId: null, ...(createdAt ? { createdAt } : {}), legacyDoc: d });
    if (status !== "CANCELLED") {
      post("SUPPLIER_RETURN", id, date, `Supplier return ${number ?? ""}`.trim(), createdAt, [supLine(supplierId, totalP, 0), plain("PURCHASE_RETURNS", 0, totalP)]);
    }
  }

  /* ── ledger-feeding documents added by later legacy patch modules ────── */

  const adjustmentIds: Ids = new Map();
  for (const d of data.accountAdjustments ?? []) {
    const id = register("accountAdjustments", adjustmentIds, d);
    const customerId = resolve("accountAdjustments", d, "customerId", "customer", customerIds);
    const date = isoDate("accountAdjustments", d, "adjustmentDate");
    const direction = oneOf("accountAdjustments", d, "direction", ["DEBIT", "CREDIT"] as const);
    const amountP = paisa("accountAdjustments", d, "amount");
    const status = oneOf("accountAdjustments", d, "status", ALLOWED_STATUS.accountAdjustments);
    const number = optStr("accountAdjustments", d, "adjustmentNumber");
    const createdAt = optTimestamp("accountAdjustments", d, "createdAt");
    const reversedAt = optTimestamp("accountAdjustments", d, "reversedAt");
    rows.accountAdjustments.push({ id, legacyId: d.id, adjustmentNumber: number, customerId, date, direction, amountP, reason: optStr("accountAdjustments", d, "reason"), status, ...(createdAt ? { createdAt } : {}), legacyDoc: d });
    const lines = receivableLines(customerId, "ACCOUNT_ADJUSTMENTS", direction === "DEBIT" ? amountP : -amountP);
    post("ADJUSTMENT", id, date, `Adjustment ${number ?? ""}`.trim(), createdAt, lines);
    if (status === "REVERSED") post("ADJUSTMENT_REVERSAL", id, date, `Reversal of adjustment ${number ?? ""}`.trim(), reversedAt ?? createdAt, swapped(lines));
  }

  const millingIds: Ids = new Map();
  for (const d of data.millingJobs ?? []) {
    const id = register("millingJobs", millingIds, d);
    const supplierId = resolve("millingJobs", d, "millId", "supplier (mill)", supplierIds);
    const date = isoDate("millingJobs", d, "jobDate");
    const status = oneOf("millingJobs", d, "status", ALLOWED_STATUS.millingJobs);
    const settle = optOneOf("millingJobs", d, "settle", ["NET", "FEE_ONLY"] as const);
    const receiveMode = optOneOf("millingJobs", d, "receiveMode", ["AT_MILL", "DELIVERED"] as const);
    const issuedValueP = paisa("millingJobs", d, "issuedValue", { optional: true });
    const receivedValueP = paisa("millingJobs", d, "receivedValue", { optional: true });
    const feeAmountP = paisa("millingJobs", d, "feeAmount", { optional: true });
    const number = optStr("millingJobs", d, "jobNumber");
    const createdAt = optTimestamp("millingJobs", d, "createdAt");
    rows.millingJobs.push({ id, legacyId: d.id, jobNumber: number, supplierId, date, settle, receiveMode, issuedValueP, receivedValueP, feeAmountP, status, ...(createdAt ? { createdAt } : {}), legacyDoc: d });
    if (status !== "CANCELLED") {
      // Legacy orders a job's three rows with a #1/#2/#3 suffix on createdAt; here they get +0/+1/+2 ms so a
      // statement lists them issue -> received -> fee deterministically (only when the job has a createdAt).
      if (settle !== "FEE_ONLY") {
        if (issuedValueP) post("MILLING_ISSUE", id, date, `Wheat issued — milling job ${number ?? ""}`.trim(), plusMs(createdAt, 0), [supLine(supplierId, issuedValueP, 0), plain("MILLING_CLEARING", 0, issuedValueP)]);
        if (receivedValueP) post("MILLING_RECEIVED", id, date, `Received from mill — milling job ${number ?? ""}`.trim(), plusMs(createdAt, 1), payableLines(supplierId, "MILLING_CLEARING", receivedValueP));
      }
      if (feeAmountP) post("MILLING_FEE", id, date, `Milling fee ${number ?? ""}`.trim(), plusMs(createdAt, 2), payableLines(supplierId, "MILLING_FEES", feeAmountP));
    }
  }

  /* ── company settings: loaded verbatim (a settings bag), after the credential check ─────────────────── */

  const businessSeen = new Set<string>();
  for (const d of data.business ?? []) {
    const id = reqStr("business", d, "id");
    if (businessSeen.has(id)) throw new ImportError(`Duplicate id in 'business': ${id}`);
    businessSeen.add(id);
    rows.companyProfile.push({ id, doc: checkCompanyDoc(d) });
  }

  /* ── sequences ───────────────────────────────────────────────────────── */

  const seqSeen = new Set<string>();
  for (const d of data.sequences ?? []) {
    const kind = reqStr("sequences", d, "kind");
    const year = integer("sequences", d, "year", 1900);
    const n = integer("sequences", d, "n", 0);
    if (d.k !== undefined && d.k !== `${kind}:${year}`) throw new ImportError(`${where("sequences", d)}: key ${JSON.stringify(d.k)} does not match ${kind}:${year}`);
    if (seqSeen.has(`${kind}:${year}`)) throw new ImportError(`Duplicate sequence ${kind}:${year}`);
    seqSeen.add(`${kind}:${year}`);
    const updatedAt = optTimestamp("sequences", d, "updatedAt");
    rows.sequences.push({ kind, year, n, ...(updatedAt ? { updatedAt } : {}) });
  }

  return { exportedAt: backup.exportedAt, storeCounts, rows, journal, migratedInvoices, migratedPurchases, warnings };
}
