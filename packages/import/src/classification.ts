/**
 * The fail-loudly guarantee (CLAUDE.md "Two projects side by side" #2).
 *
 * Every store in a backup must appear in exactly one of three lists below; a store in none of them
 * aborts the import naming the store. Every field on every document of an *imported* store must be
 * classified too: `mapped` (feeds a column), `docOnly` (kept verbatim in the row's `legacy_doc`), or
 * `ignored` (also kept in `legacy_doc`, but deliberately never read — stale or derived). An unclassified
 * field aborts the import naming store + field. Nothing is ever silently dropped.
 *
 * The three lists were built from the real 2026-09-22 nightly backup's key sets plus the legacy code that
 * writes each document (`02-services.js`, `16-khata.js`, `32-milling.js`), so fields that only appear in
 * some documents (e.g. `reversedAt` on a reversed payment) are covered even when the real data has none.
 */

/** Stores loaded into Postgres by M1. */
export const IMPORTED_STORES = {
  regions: "master data; customers reference them",
  warehouses: "master data",
  products: "master data (headers only; costs/prices/stock arrive with M2-M4)",
  customers: "master data + opening balance; the receivables side of the ledger",
  suppliers: "master data + opening balance; the payables side of the ledger",
  invoices: "header only; feeds Ledger.customer",
  purchases: "header only; feeds Ledger.supplier",
  payments: "feeds both ledgers; S3 builds the payment services on these rows",
  paymentAllocations: "payment -> invoice/purchase allocations",
  customerReturns: "header only; feeds Ledger.customer (credit note)",
  supplierReturns: "header only; feeds Ledger.supplier (debit)",
  sequences: "receipt/document counters, so S3's next number continues from the live one",
  accountAdjustments:
    "feeds Ledger.customer: 16-khata.js wraps the base ledger with adjustments (moved here from 'deferred' — the plan's own rule)",
  millingJobs:
    "feeds Ledger.supplier: 32-milling.js wraps the base ledger with issue/receive/fee rows (moved here from 'deferred' — the plan's own rule)",
} as const;

/** Stores counted but not loaded: they belong to a later milestone and do not feed either ledger. */
export const DEFERRED_STORES = {
  invoiceItems: "invoice line items — M2",
  purchaseItems: "purchase line items — M3",
  customerReturnItems: "return line items — M2",
  supplierReturnItems: "return line items — M3",
  inventory: "stock — M4",
  stockMovements: "stock — M4",
  stockDocs: "stock — M4",
  stockDocItems: "stock — M4",
  orders: "sales orders — M2",
  orderItems: "sales order lines — M2",
  expenses: "expenses — later milestone",
  landedCosts: "landed cost — M6",
  landedCostExpenses: "landed cost — M6",
  inventoryCostAdjust: "stock costing — M4",
  employees: "payroll — M7",
  salaryPayments: "payroll — M7",
  millingJobItems: "milling job lines (stock side) — M8; the job headers are imported because they feed the ledger",
  millingArrivals: "milling arrivals (stock side) — M8",
  supplierProducts: "supplier price lists — later milestone",
  priceHistory: "pricing — later milestone",
  priceApprovals: "pricing — later milestone",
  costHistory: "costing — M4/M6",
  salesmen: "salesmen — later milestone",
  documents: "issued-document register (print snapshots) — later milestone",
  documentEdits: "issued-document edit trail — later milestone",
  operations: "idempotency claims of the old client; the new API has its own",
  auditLog: "the old audit trail: kept in the backup; the new project starts its own (a one-row IMPORT entry is written)",
  business: "company settings — later milestone",
} as const;

/** Stores never read on purpose. */
export const IGNORED_STORES = {
  users: "credentials (legacy PIN + salt): never imported, never read; those accounts are locked out in the live ERP anyway",
  syncQueue: "old client's offline sync bookkeeping",
  migrationBackups: "old app's own migration safety copies",
  meta: "old app bookkeeping (schema/migration flags)",
  legacy: "old app bookkeeping (device/log/sequence side tables)",
} as const;

export type ImportedStore = keyof typeof IMPORTED_STORES;

export interface FieldClass {
  /** Feeds a column (or drives a journal entry). */
  mapped: readonly string[];
  /** Kept verbatim in `legacy_doc` only, grouped by the reason it is not mapped. */
  docOnly: readonly { reason: string; keys: readonly string[] }[];
  /** Also kept in `legacy_doc`, but stale/derived and never to be read back. */
  ignored: readonly { reason: string; keys: readonly string[] }[];
}

const M2 = "not needed by the M1 ledger; kept in legacy_doc for the module that owns it";
const PAPER_BOOK =
  "old paper-book figure, reference-only: the app's Ledger ignores it, so it is deliberately NOT posted (needs an owner-chosen cutover date — old CLAUDE.md open item 1)";
const STALE_CACHE = "stale cached field: the app's Ledger ignores it";
const DERIVED_CACHE = "cache derived from allocations/ledger at write time; recomputed, never read back";

export const FIELD_CLASSES: Record<ImportedStore, FieldClass> = {
  regions: {
    mapped: ["id", "en", "ur", "active"],
    docOnly: [{ reason: "route names — later master-data work", keys: ["routes"] }],
    ignored: [],
  },
  warehouses: { mapped: ["id", "name", "active"], docOnly: [], ignored: [] },
  products: {
    // name falls back to en, then ur (3 real products lack `name`); category falls back to cat.
    mapped: ["id", "name", "en", "ur", "category", "cat", "unit", "active"],
    docOnly: [
      {
        reason: "product catalogue detail (prices, weights, import provenance) — M2/M4",
        keys: [
          "brand", "brandEn", "kg", "sku", "barcode", "supplier", "buy", "sell", "min", "notes", "sourceCode",
          "sourceFolio", "normalizedName", "nameEn", "searchAliases", "categoryRaw", "productType", "weightKg",
          "catalogListedValue", "catalogValueIsNull", "priceTypeConfirmed", "priceConfirmed", "zeroListedValue",
          "supplierIds", "needsReview", "reviewReason", "duplicateCandidate", "categoryNeedsReview", "sourceFile",
          "sourcePage",
        ],
      },
    ],
    ignored: [],
  },
  customers: {
    mapped: [
      "id", "sh", "ow", "ph", "region", "isCashCounter", "legacyCode", "active", "openingBalanceP",
      "openingBalanceDate", "createdAt",
    ],
    docOnly: [
      {
        reason: M2,
        keys: [
          "nameUr", "wa", "addr", "regionAssumed", "area", "areaEn", "route", "alsoInFiles", "ord", "bagsOut",
          "term", "last", "needsReview", "reviewReason", "possibleDuplicate", "sourceFile", "updatedAt",
          "lim", // credit limit: null in every real row and its unit is unverified — M2 decides
        ],
      },
      { reason: PAPER_BOOK, keys: ["legacyTotalSales", "legacyTotalCollection", "legacyBalanceSigned"] },
    ],
    ignored: [{ reason: STALE_CACHE, keys: ["bal", "tot"] }],
  },
  suppliers: {
    mapped: ["id", "co", "ph", "active", "openingBalanceP", "openingBalanceDate", "createdAt"],
    docOnly: [
      {
        reason: M2,
        keys: [
          "legacyCode", "nameUr", "cp", "wa", "lo", "notes", "categoryInferred", "localityClue", "prods",
          "needsReview", "reviewReason", "accountTypeReview", "sourceFile", "email", "ntn", "terms", "updatedAt",
        ],
      },
      { reason: PAPER_BOOK, keys: ["legacyTotalSales", "legacyTotalCollection", "legacyBalanceSigned"] },
    ],
    ignored: [{ reason: STALE_CACHE, keys: ["paid", "due", "last"] }],
  },
  invoices: {
    mapped: ["id", "invoiceNumber", "customerId", "invoiceDate", "grandTotal", "status", "createdAt"],
    docOnly: [
      {
        reason: "invoice detail — M2 (line items, snapshots, charges)",
        keys: [
          "clientOpId", "invoiceType", "saleOrderId", "orderNumber", "dispatchNumber", "customerCodeSnapshot",
          "customerNameSnapshot", "shopNameSnapshot", "contactPersonSnapshot", "mobileSnapshot", "whatsappSnapshot",
          "addressSnapshot", "regionId", "regionSnapshot", "marketSnapshot", "warehouseId", "warehouseSnapshot",
          "salesperson", "dueDate", "subtotal", "discountAmount", "itemDiscounts", "invoiceDiscount", "taxAmount",
          "freightAmount", "loadingAmount", "otherCharges", "paymentMethod", "referenceNo", "notes", "totalQty",
          "lineCount", "previousBalance", "revision", "createdBy", "updatedAt", "confirmedAt", "cancelledAt",
          "cancelReason", "stockApplied", "description",
        ],
      },
    ],
    ignored: [{ reason: DERIVED_CACHE, keys: ["paidAmount", "balanceAmount", "paymentStatus"] }],
  },
  purchases: {
    mapped: ["id", "purchaseNumber", "supplierId", "purchaseDate", "grandTotal", "status", "createdAt"],
    docOnly: [
      {
        reason: "purchase detail — M3 (line items, snapshots, charges)",
        keys: [
          "clientOpId", "supplierNameSnapshot", "supplierInvoiceNo", "warehouseId", "warehouseSnapshot", "vehicleNo",
          "driver", "deliveryRef", "subtotal", "discountAmount", "taxAmount", "freightAmount", "loadingAmount",
          "otherCharges", "notes", "totalQty", "lineCount", "createdBy", "updatedAt", "stockApplied", "orderedQty",
          "receivedQty", "revision", "description",
        ],
      },
    ],
    ignored: [{ reason: DERIVED_CACHE, keys: ["paidAmount", "balanceAmount", "paymentStatus"] }],
  },
  payments: {
    mapped: [
      "id", "receiptNumber", "direction", "partyId", "partyType", "isRefund", "amount", "method", "reference",
      "paymentDate", "note", "receivedBy", "status", "createdAt",
      "reversedAt", // only on reversed payments: dates the reversing journal entry
    ],
    docOnly: [
      {
        reason: "snapshots / provenance — kept for the audit trail",
        keys: [
          "partyNameSnapshot", "partyOwnerSnapshot", "regionSnapshot", "createdBy", "description", "reverseReason",
        ],
      },
    ],
    ignored: [
      {
        reason: "balance stamped at write time; the ledger reads amount live and nothing reads these back",
        keys: ["balanceBefore", "balanceAfter"],
      },
    ],
  },
  paymentAllocations: {
    mapped: ["id", "paymentId", "invoiceId", "purchaseId", "amount", "createdAt"],
    docOnly: [],
    ignored: [],
  },
  customerReturns: {
    mapped: ["id", "returnNumber", "customerId", "returnDate", "creditAmount", "treatment", "status", "createdAt"],
    docOnly: [
      {
        reason: "return detail — M2 (line items live in customerReturnItems)",
        keys: [
          "clientOpId", "invoiceId", "invoiceNumber", "customerNameSnapshot", "regionSnapshot", "warehouseId",
          "warehouseSnapshot", "reason", "condition", "notes", "description", "replacementValue", "totalQty",
          "lineCount", "createdBy", "updatedAt", "cancelledAt", "cancelReason",
        ],
      },
    ],
    ignored: [],
  },
  supplierReturns: {
    mapped: ["id", "returnNumber", "supplierId", "returnDate", "debitAmount", "status", "createdAt"],
    docOnly: [
      {
        reason: "return detail — M3 (line items live in supplierReturnItems)",
        keys: [
          "clientOpId", "supplierNameSnapshot", "purchaseId", "purchaseNumber", "warehouseId", "warehouseSnapshot",
          "reason", "notes", "description", "expectReplacement", "totalQty", "lineCount", "createdBy",
          "replacementReceived", "replacedAt", "updatedAt", "cancelledAt", "cancelReason",
        ],
      },
    ],
    ignored: [],
  },
  sequences: {
    mapped: ["kind", "year", "n", "updatedAt"],
    docOnly: [],
    ignored: [{ reason: "derived key `<kind>:<year>`; checked against kind/year, then dropped", keys: ["k"] }],
  },
  accountAdjustments: {
    mapped: [
      "id", "adjustmentNumber", "customerId", "adjustmentDate", "direction", "amount", "reason", "status",
      "createdAt", "reversedAt",
    ],
    docOnly: [
      {
        reason: "snapshots / provenance",
        keys: ["clientOpId", "customerNameSnapshot", "notes", "description", "createdBy", "reverseReason"],
      },
    ],
    ignored: [],
  },
  millingJobs: {
    mapped: [
      "id", "jobNumber", "millId", "jobDate", "settle", "receiveMode", "issuedValue", "receivedValue", "feeAmount",
      "status", "createdAt",
    ],
    docOnly: [
      {
        reason: "milling detail — M8 (weights, loss, notes)",
        keys: [
          "clientOpId", "millSnapshot", "warehouseId", "warehouseSnapshot", "inWeightKg", "outWeightKg", "lossKg",
          "lossPct", "feeNote", "netAmount", "notes", "cancelReason", "cancelledAt", "createdBy", "updatedAt",
        ],
      },
    ],
    ignored: [],
  },
};

export function knownFields(store: ImportedStore): Set<string> {
  const c = FIELD_CLASSES[store];
  return new Set([
    ...c.mapped,
    ...c.docOnly.flatMap((g) => g.keys),
    ...c.ignored.flatMap((g) => g.keys),
  ]);
}

/** Statuses the legacy app is known to write. An unknown value aborts rather than being guessed at. */
export const ALLOWED_STATUS = {
  invoices: ["DRAFT", "CONFIRMED", "DISPATCHED", "PARTIALLY_PAID", "PAID", "CANCELLED", "RETURNED", "PARTIALLY_RETURNED"],
  purchases: ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  payments: ["POSTED", "REVERSED"],
  customerReturns: ["DRAFT", "POSTED", "CANCELLED"],
  supplierReturns: ["DRAFT", "POSTED", "CANCELLED"],
  accountAdjustments: ["POSTED", "REVERSED"],
  millingJobs: ["POSTED", "CANCELLED"],
} as const;
