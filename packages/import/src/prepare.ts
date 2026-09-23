import { createHash } from "node:crypto";
import type {
  accountAdjustments,
  customers,
  invoices,
  millingJobs,
  paymentAllocations,
  payments,
  products,
  purchases,
  regions,
  returns,
  sequences,
  suppliers,
  warehouses,
} from "@farooq/db";
import {
  custLine,
  paymentLines,
  paymentMemo,
  paymentReversalMemo,
  plainLine as plain,
  reversedLines,
  supLine,
  PAYMENT_REVERSAL_SOURCE,
  PAYMENT_SOURCE,
  type AccountCode,
  type JournalLineDraft,
} from "@farooq/db";
import { ALLOWED_STATUS } from "./classification.js";
import {
  checkClassification,
  checkEnvelope,
  ImportError,
  integer,
  isoDate,
  oneOf,
  optBool,
  optIsoDate,
  optOneOf,
  optStr,
  optTimestamp,
  paisa,
  reqStr,
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
    purchases: (typeof purchases.$inferInsert)[];
    payments: (typeof payments.$inferInsert)[];
    paymentAllocations: (typeof paymentAllocations.$inferInsert)[];
    returns: (typeof returns.$inferInsert)[];
    accountAdjustments: (typeof accountAdjustments.$inferInsert)[];
    millingJobs: (typeof millingJobs.$inferInsert)[];
    sequences: (typeof sequences.$inferInsert)[];
  };
  journal: JournalDraft[];
  /** Non-fatal observations (e.g. a REFUND return with no matching cash payment). */
  warnings: string[];
}

type Ids = Map<string, string>;

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
    purchases: [],
    payments: [],
    paymentAllocations: [],
    returns: [],
    accountAdjustments: [],
    millingJobs: [],
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
    rows.products.push({
      id,
      legacyId: d.id,
      name,
      category: optStr("products", d, "category") ?? optStr("products", d, "cat"),
      unit: optStr("products", d, "unit"),
      active: optBool("products", d, "active", true),
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

  for (const d of data.invoices ?? []) {
    const id = register("invoices", invoiceIds, d);
    const customerId = resolve("invoices", d, "customerId", "customer", customerIds);
    const date = isoDate("invoices", d, "invoiceDate");
    const totalP = paisa("invoices", d, "grandTotal");
    const status = oneOf("invoices", d, "status", ALLOWED_STATUS.invoices);
    const createdAt = optTimestamp("invoices", d, "createdAt");
    const number = optStr("invoices", d, "invoiceNumber");
    rows.invoices.push({ id, legacyId: d.id, invoiceNumber: number, customerId, date, totalP, status, ...(createdAt ? { createdAt } : {}), legacyDoc: d });
    // A skipped (DRAFT/CANCELLED) invoice is still imported as a row, just with no journal entry.
    if (status !== "DRAFT" && status !== "CANCELLED") {
      post("INVOICE", id, date, `Sales invoice ${number ?? ""}`.trim(), createdAt, receivableLines(customerId, "SALES", totalP));
    }
  }

  for (const d of data.purchases ?? []) {
    const id = register("purchases", purchaseIds, d);
    const supplierId = resolve("purchases", d, "supplierId", "supplier", supplierIds);
    const date = isoDate("purchases", d, "purchaseDate");
    const totalP = paisa("purchases", d, "grandTotal");
    const status = oneOf("purchases", d, "status", ALLOWED_STATUS.purchases);
    const createdAt = optTimestamp("purchases", d, "createdAt");
    const number = optStr("purchases", d, "purchaseNumber");
    rows.purchases.push({ id, legacyId: d.id, purchaseNumber: number, supplierId, date, totalP, status, ...(createdAt ? { createdAt } : {}), legacyDoc: d });
    if (status !== "CANCELLED") {
      post("PURCHASE", id, date, `Purchase ${number ?? ""}`.trim(), createdAt, payableLines(supplierId, "PURCHASES", totalP));
    }
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

  return { exportedAt: backup.exportedAt, storeCounts, rows, journal, warnings };
}
