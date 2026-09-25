import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Money is always integer paisa, stored as Postgres `bigint` (CLAUDE.md rule
 * #5). At the JS layer we read/write it as a plain `number` — paisa amounts
 * for this business are nowhere near Number.MAX_SAFE_INTEGER (9e15), and the
 * old app's `amountP` was a plain JS number too. Documented in STATUS.md.
 */
const moneyP = (column: string) => bigint(column, { mode: "number" }).notNull().default(0);

const id = () => uuid("id").primaryKey().defaultRandom();
const legacyId = () => text("legacy_id").unique();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
/** The untouched legacy JSON document this row was imported from (S2) — nothing is silently lost. */
const legacyDoc = () => jsonb("legacy_doc");

/* ── master data ──────────────────────────────────────────────────────── */

export const regions = pgTable("regions", {
  id: id(),
  legacyId: legacyId(),
  nameEn: text("name_en").notNull(),
  nameUr: text("name_ur"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  legacyDoc: legacyDoc(),
  /** Folded "اردو English" (the legacy `regionTxt`), for payment search. Generated: never written by the app. */
  searchText: text("search_text").generatedAlwaysAs(sql`fold_search(COALESCE(name_ur, '') || ' ' || name_en)`),
});

export const warehouses = pgTable("warehouses", {
  id: id(),
  legacyId: legacyId(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  legacyDoc: legacyDoc(),
});

export const products = pgTable("products", {
  id: id(),
  legacyId: legacyId(),
  name: text("name").notNull(),
  category: text("category"),
  unit: text("unit"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  legacyDoc: legacyDoc(),
  /* Catalogue fields the invoice builder needs (S6). `name` stays the display name the M1 screens use. */
  nameUr: text("name_ur"),
  nameEn: text("name_en"),
  brand: text("brand"),
  brandEn: text("brand_en"),
  weightKg: doublePrecision("weight_kg"),
  sku: text("sku"),
  barcode: text("barcode"),
  /* The Prices panel (legacy `Prices.of`, 21-settings.js). Paisa, all nullable: null = never set. Mapped from the
     `…P` field when present, else from the legacy rupee field (`buy`, `sell`, `min`, `extra`). The legacy also falls
     back to an average cost derived from purchases for `buy` — that is derived data (M4), not stored here. */
  buyP: bigint("buy_p", { mode: "number" }),
  sellP: bigint("sell_p", { mode: "number" }),
  extraP: bigint("extra_p", { mode: "number" }),
  minSellP: bigint("min_sell_p", { mode: "number" }),
  wholesaleP: bigint("wholesale_p", { mode: "number" }),
  retailP: bigint("retail_p", { mode: "number" }),
  discountPct: doublePrecision("discount_pct"),
  taxPct: doublePrecision("tax_pct"),
  /** Stock alert level in units (bags). */
  reorder: doublePrecision("reorder"),
  /**
   * (S13) The product's CURRENT folded text as the legacy Purchases toolbar searched it (`pTxt`: ur, en, brandEn, cat, sku, id, kg,
   * sourceFolio, normalizedName, nameEn) — plus `category` (the imported `category ?? cat`). Generated: never written by the app.
   */
  searchText: text("search_text").generatedAlwaysAs(
    sql`COALESCE(search_join(name_ur, name_en, brand_en, category, legacy_doc->>'cat', sku, legacy_id, legacy_doc->>'kg'), '') || chr(1) || COALESCE(search_join(legacy_doc->>'sourceFolio', legacy_doc->>'normalizedName', legacy_doc->>'nameEn'), '')`,
  ),
});

export const suppliers = pgTable("suppliers", {
  id: id(),
  legacyId: legacyId(),
  companyName: text("company_name").notNull(),
  phone: text("phone"),
  /** Signed paisa, "what we owe them" positive (legacy `openingBalanceP`); posted to PAYABLES vs OPENING_EQUITY. */
  openingBalanceP: bigint("opening_balance_p", { mode: "number" }).notNull().default(0),
  openingBalanceDate: date("opening_balance_date"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  legacyDoc: legacyDoc(),
  /** Folded searchable text of the supplier's CURRENT details (payment search). Generated: never written by the app. */
  searchText: text("search_text").generatedAlwaysAs(
    sql`search_join(company_name, legacy_doc->>'cp', phone, search_compact(phone), legacy_doc->>'lo')`,
  ),
});

export const customers = pgTable("customers", {
  id: id(),
  legacyId: legacyId(),
  shopName: text("shop_name").notNull(),
  ownerName: text("owner_name"),
  phone: text("phone"),
  regionId: uuid("region_id").references(() => regions.id),
  creditLimitP: bigint("credit_limit_p", { mode: "number" }).notNull().default(0),
  /** Signed paisa, "what they owe us" positive (legacy `openingBalanceP`); posted to RECEIVABLES vs OPENING_EQUITY. */
  openingBalanceP: bigint("opening_balance_p", { mode: "number" }).notNull().default(0),
  openingBalanceDate: date("opening_balance_date"),
  isCashCounter: boolean("is_cash_counter").notNull().default(false),
  legacyCode: text("legacy_code"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  legacyDoc: legacyDoc(),
  /** Folded searchable text of the shop's CURRENT details (payment search); its region is added from regions.search_text. Generated. */
  searchText: text("search_text").generatedAlwaysAs(
    sql`search_join(shop_name, owner_name, legacy_doc->>'nameUr', phone, search_compact(phone), legacy_doc->>'wa', legacy_code)`,
  ),
});

/**
 * The legacy `business` settings document (~60 keys: name, address, phones, prefixes, terms, ...), loaded VERBATIM by
 * the importer (S4). It is a settings bag the app reads whole, so there is no per-field mapping; the API exposes a
 * whitelist of display fields only (`GET /company`), never this blob. Never holds a credential (the importer refuses).
 */
export const companyProfile = pgTable("company_profile", {
  id: text("id").primaryKey(),
  doc: jsonb("doc").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── users, sessions, RBAC ────────────────────────────────────────────── */

/**
 * `role` is plain text, not a Postgres enum: the set of valid roles is
 * owned by `packages/shared` (single source of truth for both api and web).
 * Validated at the application boundary (Zod), not by a DB constraint.
 */
export const users = pgTable("users", {
  id: id(),
  legacyId: legacyId(),
  name: text("name").notNull(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  active: boolean("active").notNull().default(true),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  csrfToken: text("csrf_token").notNull(),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Seeded from `packages/shared`'s ROLE_PERMISSIONS at migrate time — never
 * hand-retyped. OWNER is not a row here; it is implicitly all-permissions
 * (see the permission guard).
 */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    role: text("role").notNull(),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.role, t.permission] })],
);

/* ── chart of accounts + double-entry ledger ─────────────────────────── */

export const accounts = pgTable("accounts", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  type: text("type").notNull(), // ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
  partyType: text("party_type"), // CUSTOMER | SUPPLIER | null — unused: parties live on journal *lines*
  partyId: uuid("party_id"),
  createdAt: createdAt(),
});

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    date: date("date").notNull(),
    memo: text("memo"),
    /** The document this entry posts (INVOICE, PAYMENT, PAYMENT_REVERSAL, ...): exactly one entry per (type, id). */
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    createdBy: uuid("created_by").references(() => users.id),
    /** clock_timestamp(), not now(): two entries posted in ONE transaction (an invoice and the receipt taken with it) must not tie,
     *  or a statement could show the receipt before the invoice it pays. `now()` is the transaction's start time. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [uniqueIndex("journal_entries_source_uq").on(t.sourceType, t.sourceId)],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    partyType: text("party_type"),
    partyId: uuid("party_id"),
    debitP: moneyP("debit_p"),
    creditP: moneyP("credit_p"),
  },
  (t) => [
    index("journal_lines_entry_id_idx").on(t.entryId),
    // A party's balance is the sum of its lines on RECEIVABLES / PAYABLES (S3 balance endpoints).
    index("journal_lines_party_idx").on(t.partyType, t.partyId),
  ],
);

/* ── audit log (append-only — see migration 0002 for the REVOKE) ────────── */

export const auditLog = pgTable("audit_log", {
  id: id(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── receipt / document numbering ────────────────────────────────────────
   Not a Postgres SEQUENCE object: a per-kind-per-year counter, taken with
   `INSERT ... ON CONFLICT (kind, year) DO UPDATE SET n = n + 1 RETURNING n`
   inside the same transaction as the document it numbers (S3 `nextNumber`).
   That mirrors the legacy `FDB.nextNumber`, which also read and wrote the
   counter inside the document's own transaction: a rolled-back save does NOT
   consume a number, so committed numbers are gap-free. (S1's note claimed the
   opposite; the legacy code says otherwise for payments.) */
export const sequences = pgTable(
  "sequences",
  {
    kind: text("kind").notNull(),
    year: integer("year").notNull(),
    n: integer("n").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.year] })],
);

/* ── request keys (S7) ───────────────────────────────────────────────────
   Makes an invoice save safe to repeat: the first request with a key writes the invoice and records (key -> invoice);
   a second request with the same key gets that invoice back and writes nothing. Payments carry their key on the
   voucher row (S3); an invoice edit has no row of its own to carry one, hence this table. */
export const requestKeys = pgTable("request_keys", {
  key: text("key").primaryKey(),
  kind: text("kind").notNull(),
  entityId: uuid("entity_id").notNull(),
  createdAt: createdAt(),
});

/* ── transaction tables: invoices carry lines since S6, purchases since S11 ────────── */

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    legacyId: legacyId(),
    /** Drafts carry no number (NULL): the partial unique index below lets any number of drafts exist. */
    invoiceNumber: text("invoice_number"),
    customerId: uuid("customer_id").references(() => customers.id),
    date: date("date").notNull(),
    /** The grand total (legacy `grandTotal`) — what posts to RECEIVABLES / SALES. */
    totalP: moneyP("total_p"),
    /** The legacy status string, verbatim (DRAFT, CONFIRMED, PARTIALLY_PAID, PAID, CANCELLED, ...). */
    status: text("status").notNull().default("DRAFT"),
    createdAt: createdAt(),
    legacyDoc: legacyDoc(),
    /** Folded number and its compact form, so a payment can be found by the invoice it was applied to. Generated. */
    searchNumber: text("search_number").generatedAlwaysAs(sql`search_join(invoice_number, search_compact(invoice_number))`),

    /* ── S6: the rest of the header, mapped out of legacy_doc (S7 writes them). paidAmount / balanceAmount /
       paymentStatus are NOT stored: they are derived from the payment allocations (S2 decision). ── */
    invoiceType: text("invoice_type").notNull().default("SALE"),
    dueDate: date("due_date"),
    warehouseId: uuid("warehouse_id").references(() => warehouses.id),
    salesperson: text("salesperson"),
    subtotalP: moneyP("subtotal_p"),
    itemDiscountsP: moneyP("item_discounts_p"),
    invoiceDiscountP: moneyP("invoice_discount_p"),
    /** Σ line tax (legacy `taxAmount`). */
    taxP: moneyP("tax_p"),
    freightP: moneyP("freight_p"),
    loadingP: moneyP("loading_p"),
    otherChargesP: moneyP("other_charges_p"),
    paymentMethod: text("payment_method"),
    referenceNo: text("reference_no"),
    notes: text("notes"),
    description: text("description"),
    /** Signed paisa: the shop's balance before this sale, as printed (legacy `previousBalance`). */
    previousBalanceP: bigint("previous_balance_p", { mode: "number" }).notNull().default(0),
    /** Σ line quantities in thousandths of a bag. */
    totalQtyMilli: bigint("total_qty_milli", { mode: "number" }).notNull().default(0),
    lineCount: integer("line_count").notNull().default(0),
    /** True while this invoice's stock is out of the godown (SALE_OUT booked, not yet reversed). */
    stockApplied: boolean("stock_applied").notNull().default(false),
    /** Legacy `migrated: true`: created by the old app's data migration with `stockApplied` but NO SALE_OUT movements.
     *  S7 must never "reverse" the stock of such an invoice — it was never taken by a movement. */
    migrated: boolean("migrated").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    /** The user who saved it (S7). Null on imported rows: the legacy app stored a display name, kept in legacy_doc. */
    createdBy: uuid("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /** The sale order it came from — the legacy id only in M2 (sale orders are M9). */
    saleOrderId: text("sale_order_id"),
    orderNumber: text("order_number"),
    dispatchNumber: text("dispatch_number"),
    /* What the invoice printed about the shop when it was made (legacy `customerFields`): a later rename of the shop
       does not change an old invoice. */
    customerCodeSnapshot: text("customer_code_snapshot"),
    customerNameSnapshot: text("customer_name_snapshot"),
    shopNameSnapshot: text("shop_name_snapshot"),
    contactPersonSnapshot: text("contact_person_snapshot"),
    mobileSnapshot: text("mobile_snapshot"),
    whatsappSnapshot: text("whatsapp_snapshot"),
    addressSnapshot: text("address_snapshot"),
    regionId: uuid("region_id").references(() => regions.id),
    regionSnapshot: text("region_snapshot"),
    marketSnapshot: text("market_snapshot"),
    warehouseSnapshot: text("warehouse_snapshot"),

    /* ── S8: the folded text of every searchable field, as the legacy `InvoiceSearch.build()` indexed it. Generated (never
       written by the app, never stale, no triggers), like S4's `search_number`. What cannot be a column of this row stays a
       query: the shop's CURRENT text, the receipts applied, the product lines (`invoice_items.search_text`) and the payment
       status word (it follows the receipts). ── */
    /** Invoice number and its compact form, the order / dispatch numbers and the invoice's own reference. */
    searchNumbers: text("search_numbers").generatedAlwaysAs(
      sql`search_join(invoice_number, search_compact(invoice_number), order_number, dispatch_number, reference_no)`,
    ),
    /** The shop / owner / mobile (and its compact form) / region as printed on the invoice. */
    searchCustomer: text("search_customer").generatedAlwaysAs(
      sql`search_join(shop_name_snapshot, customer_name_snapshot, mobile_snapshot, search_compact(mobile_snapshot), region_snapshot)`,
    ),
    /** Every form the grand total can be typed in. */
    searchAmount: text("search_amount").generatedAlwaysAs(sql`search_amount_text(total_p)`),
    /** Every form the invoice date can be typed in. */
    searchDate: text("search_date").generatedAlwaysAs(sql`search_date_text(date)`),
    /** Notes, description, salesperson, payment method, warehouse and the status as the legacy words it ("Partly paid"). */
    searchOther: text("search_other").generatedAlwaysAs(
      sql`search_join(notes, description, salesperson, payment_method, warehouse_snapshot, CASE status WHEN 'DRAFT' THEN 'Draft' WHEN 'CONFIRMED' THEN 'Confirmed' WHEN 'DISPATCHED' THEN 'Dispatched' WHEN 'PARTIALLY_PAID' THEN 'Partly paid' WHEN 'PAID' THEN 'Paid' WHEN 'CANCELLED' THEN 'Cancelled' WHEN 'RETURNED' THEN 'Returned' WHEN 'PARTIALLY_RETURNED' THEN 'Partly returned' END)`,
    ),
  },
  (t) => [
    index("invoices_invoice_number_idx").on(t.invoiceNumber),
    index("invoices_customer_idx").on(t.customerId),
    index("invoices_warehouse_idx").on(t.warehouseId),
    // One number, one invoice — but drafts have no number, so any number of them may exist (legacy bug: one draft only).
    uniqueIndex("invoices_invoice_number_uq")
      .on(t.invoiceNumber)
      .where(sql`${t.invoiceNumber} IS NOT NULL`),
    check(
      "invoices_amounts_chk",
      sql`${t.subtotalP} >= 0 AND ${t.itemDiscountsP} >= 0 AND ${t.invoiceDiscountP} >= 0 AND ${t.taxP} >= 0 AND ${t.freightP} >= 0 AND ${t.loadingP} >= 0 AND ${t.otherChargesP} >= 0 AND ${t.totalQtyMilli} >= 0 AND ${t.lineCount} >= 0`,
    ),
  ],
);

/** One line of an invoice, as it was on the day (the snapshot columns keep an old invoice true after a rename or a price change). */
export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: id(),
    legacyId: legacyId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    sortOrder: integer("sort_order").notNull().default(0),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    descriptionSnapshot: text("description_snapshot"),
    descriptionEnSnapshot: text("description_en_snapshot"),
    brandSnapshot: text("brand_snapshot"),
    categorySnapshot: text("category_snapshot"),
    packageSnapshot: text("package_snapshot"),
    skuSnapshot: text("sku_snapshot"),
    unit: text("unit").notNull().default("Bag"),
    /** Quantity in thousandths of a unit (2.5 bags = 2500); always > 0. */
    qtyMilli: bigint("qty_milli", { mode: "number" }).notNull(),
    unitPriceP: bigint("unit_price_p", { mode: "number" }).notNull(),
    discountP: moneyP("discount_p"),
    taxP: moneyP("tax_p"),
    /** gross − discount + tax, stored as the legacy stored it; reconciliation recomputes it. */
    lineTotalP: bigint("line_total_p", { mode: "number" }).notNull(),
    /** What one unit cost us when this was sold (legacy `Inventory.costOf`); null when the legacy had none. Feeds profit (S8). */
    costSnapshotP: bigint("cost_snapshot_p", { mode: "number" }),
    /** Filled by returns (M5). */
    returnedQtyMilli: bigint("returned_qty_milli", { mode: "number" }).notNull().default(0),
    batchNo: text("batch_no"),
    notes: text("notes"),
    legacyDoc: legacyDoc(),
    /** (S8) The folded name of the line — English name, Urdu name and brand as printed — for the product search. Generated. */
    searchText: text("search_text").generatedAlwaysAs(sql`fold_search(COALESCE(description_en_snapshot, '') || ' ' || COALESCE(description_snapshot, '') || ' ' || COALESCE(brand_snapshot, ''))`),
  },
  (t) => [
    index("invoice_items_invoice_idx").on(t.invoiceId, t.sortOrder),
    index("invoice_items_product_idx").on(t.productId),
    check("invoice_items_qty_chk", sql`${t.qtyMilli} > 0 AND ${t.returnedQtyMilli} >= 0 AND ${t.returnedQtyMilli} <= ${t.qtyMilli}`),
    check("invoice_items_money_chk", sql`${t.unitPriceP} >= 0 AND ${t.discountP} >= 0 AND ${t.taxP} >= 0 AND ${t.lineTotalP} >= 0`),
    // discount <= gross, where gross = round-half-up(unit price x qty / 1000). In exact integer arithmetic:
    // discount <= floor(x + 0.5)  <=>  1000 * discount <= unit price * qty_milli + 500.
    check("invoice_items_discount_chk", sql`1000 * ${t.discountP} <= ${t.unitPriceP} * ${t.qtyMilli} + 500`),
  ],
);

/* ── stock (S6): movements are the record, levels the current figure ──────
   Pulled forward from M4 because an invoice cannot be correct without them. Quantities are thousandths of a bag
   (`*_milli`). `stock_movements` is append-only (REVOKE in migration 0005, like audit_log); `stock_levels` is kept in
   the SAME transaction as every movement by the services (S7), and reconciliation proves level = sum of movements. */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    legacyId: legacyId(),
    /** Business date (never built from toISOString). */
    date: date("date").notNull(),
    createdAt: createdAt(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    /** The legacy movement kind, verbatim (SALE_OUT, SALE_REVERSAL_IN, PURCHASE_IN, ADJUSTMENT_IN, ...). */
    kind: text("kind").notNull(),
    /** `stock` = sellable; `damaged` = the damaged bucket (returns, write-offs). */
    bucket: text("bucket").notNull().default("stock"),
    qtyDeltaMilli: bigint("qty_delta_milli", { mode: "number" }).notNull(),
    /** Cost per unit when known (legacy `unitCostP`; 0 = unknown -> null). */
    unitCostP: bigint("unit_cost_p", { mode: "number" }),
    /** The legacy free-text reference (an invoice / purchase / stock-document number) and its type. */
    ref: text("ref"),
    refType: text("ref_type"),
    /** The document that caused it: `INVOICE` / `PURCHASE` + its id when the reference resolves; other types carry no id yet. */
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    note: text("note"),
    /** Null on imported rows: the legacy stored a display name (kept in legacy_doc). */
    createdBy: uuid("created_by").references(() => users.id),
    legacyDoc: legacyDoc(),
  },
  (t) => [
    index("stock_movements_level_idx").on(t.productId, t.warehouseId, t.bucket),
    index("stock_movements_source_idx").on(t.sourceType, t.sourceId),
    check("stock_movements_bucket_chk", sql`${t.bucket} IN ('stock', 'damaged')`),
    check("stock_movements_qty_chk", sql`${t.qtyDeltaMilli} <> 0`),
  ],
);

export const stockLevels = pgTable(
  "stock_levels",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    bucket: text("bucket").notNull().default("stock"),
    /** Current quantity in thousandths. May be negative: legacy allows negative stock; enforcement is the service's job (S7). */
    qtyMilli: bigint("qty_milli", { mode: "number" }).notNull().default(0),
    /** Carried VERBATIM from the legacy `inventory` row (stock bucket only) and read by `costOf` (S7); maintained by
     *  purchases / conversions from M3-M4 - nothing in M2 recomputes them. */
    avgCostP: bigint("avg_cost_p", { mode: "number" }).notNull().default(0),
    lastCostP: bigint("last_cost_p", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.warehouseId, t.bucket] }),
    check("stock_levels_bucket_chk", sql`${t.bucket} IN ('stock', 'damaged')`),
  ],
);

/**
 * A supplier bill (legacy `purchases`). S11 gave it the full header and its lines (`purchase_items`); the service and API are S12.
 * `paidAmount` / `balanceAmount` / `paymentStatus` are NOT stored: they are derived from the payment allocations (S2 decision).
 * The legacy has no purchase drafts and no cancel: a saved purchase is RECEIVED, PARTIALLY_RECEIVED or ORDERED (from the bags
 * its lines received). DRAFT / CANCELLED rows exist only in old or hand-made data; both still import, and DRAFT posts.
 */
export const purchases = pgTable(
  "purchases",
  {
    id: id(),
    legacyId: legacyId(),
    purchaseNumber: text("purchase_number"),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    date: date("date").notNull(),
    /** The grand total (legacy `grandTotal`) - what posts to PURCHASES / PAYABLES. */
    totalP: moneyP("total_p"),
    status: text("status").notNull().default("DRAFT"),
    createdAt: createdAt(),
    legacyDoc: legacyDoc(),
    /** Folded number and its compact form (see invoices.search_number). Generated. */
    searchNumber: text("search_number").generatedAlwaysAs(sql`search_join(purchase_number, search_compact(purchase_number))`),

    /* ── S11: the rest of the header, mapped out of legacy_doc (S12 writes them) ── */
    /* What the bill printed about the supplier / godown when it was made: a later rename does not change an old purchase. */
    supplierNameSnapshot: text("supplier_name_snapshot"),
    /** The supplier's own bill number (legacy `supplierInvoiceNo`). */
    supplierInvoiceNo: text("supplier_invoice_no"),
    /** The header's default godown; every LINE carries its own (`purchase_items.warehouse_id`) and that is the one stock moves in. */
    warehouseId: uuid("warehouse_id").references(() => warehouses.id),
    warehouseSnapshot: text("warehouse_snapshot"),
    vehicleNo: text("vehicle_no"),
    driver: text("driver"),
    deliveryRef: text("delivery_ref"),
    /** Σ gross (unit price x quantity) before any discount. */
    subtotalP: moneyP("subtotal_p"),
    /** The legacy stores line discounts + the overall discount as ONE figure and this keeps that meaning; the overall part is this minus Σ line discounts (legacy `toDraft`). */
    discountAmountP: moneyP("discount_amount_p"),
    /** Σ line tax. */
    taxP: moneyP("tax_p"),
    freightP: moneyP("freight_p"),
    loadingP: moneyP("loading_p"),
    otherChargesP: moneyP("other_charges_p"),
    /** Σ ordered bags (legacy `totalQty`) / Σ ordered / Σ received bags, thousandths. */
    totalQtyMilli: bigint("total_qty_milli", { mode: "number" }).notNull().default(0),
    orderedQtyMilli: bigint("ordered_qty_milli", { mode: "number" }).notNull().default(0),
    receivedQtyMilli: bigint("received_qty_milli", { mode: "number" }).notNull().default(0),
    lineCount: integer("line_count").notNull().default(0),
    notes: text("notes"),
    description: text("description"),
    /** True while the received bags are in the godown (PURCHASE_IN booked). */
    stockApplied: boolean("stock_applied").notNull().default(false),
    /** Legacy `migrated: true`: made by the old app's data migration from the single-product purchase record. */
    migrated: boolean("migrated").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    /** The user who saved it (S12). Null on imported rows: the legacy app stored a display name, kept in legacy_doc. */
    createdBy: uuid("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** The old client's offline-sync operation id, verbatim; the new API keeps its own idempotency in `request_keys`. */
    clientOpId: text("client_op_id"),

    /* ── S13: the folded text of the purchase's own searchable fields (generated, like the invoices' S8 columns). What follows
       other tables stays a query: the supplier's CURRENT text (`suppliers.search_text`), the lines (`purchase_items.search_text`)
       and the products' current text (`products.search_text`). ── */
    /** Purchase number and its compact form, the supplier's bill number and its compact form, the delivery reference. */
    searchNumbers: text("search_numbers").generatedAlwaysAs(
      sql`search_join(purchase_number, search_compact(purchase_number), supplier_invoice_no, search_compact(supplier_invoice_no), delivery_ref)`,
    ),
    /** The supplier as printed on the bill. */
    searchSupplier: text("search_supplier").generatedAlwaysAs(sql`fold_search(supplier_name_snapshot)`),
    /** Every form the grand total can be typed in. */
    searchAmount: text("search_amount").generatedAlwaysAs(sql`search_amount_text(total_p)`),
    /** Every form the purchase date can be typed in. */
    searchDate: text("search_date").generatedAlwaysAs(sql`search_date_text(date)`),
    /** Vehicle (and its compact form), driver, the header godown as printed, notes, description. */
    searchOther: text("search_other").generatedAlwaysAs(
      sql`search_join(vehicle_no, search_compact(vehicle_no), driver, warehouse_snapshot, notes, description)`,
    ),
  },
  (t) => [
    index("purchases_purchase_number_idx").on(t.purchaseNumber),
    index("purchases_supplier_idx").on(t.supplierId),
    index("purchases_warehouse_idx").on(t.warehouseId),
    // One number, one purchase (a NULL number identifies nothing).
    uniqueIndex("purchases_purchase_number_uq")
      .on(t.purchaseNumber)
      .where(sql`${t.purchaseNumber} IS NOT NULL`),
    check(
      "purchases_amounts_chk",
      sql`${t.subtotalP} >= 0 AND ${t.discountAmountP} >= 0 AND ${t.taxP} >= 0 AND ${t.freightP} >= 0 AND ${t.loadingP} >= 0 AND ${t.otherChargesP} >= 0 AND ${t.totalQtyMilli} >= 0 AND ${t.orderedQtyMilli} >= 0 AND ${t.receivedQtyMilli} >= 0 AND ${t.lineCount} >= 0`,
    ),
  ],
);

/**
 * One line of a purchase, as it was on the day. Modelled on `invoice_items`, with two differences: the godown is per LINE, and the
 * bags ORDERED (`qty_milli`) and RECEIVED (`received_qty_milli`) are separate. Lines are not append-only: an edit (S12) updates them
 * in place because their ids stay stable (supplier returns and landed-cost entries point at them).
 *
 * Who writes the cost columns: S12's purchase save writes `goods_unit_cost_p`, `charge_share_p` and `landed_unit_cost_p`
 * (`allocateCharges` in @farooq/shared); the landed-cost module (M6) writes `operational_share_p` (the sum of the line's
 * non-cancelled landed-cost adjustments) and folds it into `landed_unit_cost_p`. NULL = never computed.
 */
export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: id(),
    legacyId: legacyId(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id),
    sortOrder: integer("sort_order").notNull().default(0),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    descriptionSnapshot: text("description_snapshot"),
    descriptionEnSnapshot: text("description_en_snapshot"),
    brandSnapshot: text("brand_snapshot"),
    packageSnapshot: text("package_snapshot"),
    unit: text("unit").notNull().default("Bag"),
    /** The bags ORDERED, thousandths; always > 0. */
    qtyMilli: bigint("qty_milli", { mode: "number" }).notNull(),
    /** The bags that ARRIVED, thousandths. The legacy `receivedQty` is absent on old lines = the whole quantity; the importer stores the
     *  resolved number and keeps the raw one in legacy_doc. Not capped at the ordered bags: the legacy allowed raising "ordered" on a full load. */
    receivedQtyMilli: bigint("received_qty_milli", { mode: "number" }).notNull().default(0),
    /** Filled by supplier returns (M5). */
    returnedQtyMilli: bigint("returned_qty_milli", { mode: "number" }).notNull().default(0),
    unitPriceP: bigint("unit_price_p", { mode: "number" }).notNull(),
    discountP: moneyP("discount_p"),
    taxP: moneyP("tax_p"),
    /** gross - discount + tax, as the legacy stored it; reconciliation recomputes it. */
    lineTotalP: bigint("line_total_p", { mode: "number" }).notNull(),
    goodsUnitCostP: bigint("goods_unit_cost_p", { mode: "number" }),
    chargeShareP: bigint("charge_share_p", { mode: "number" }),
    landedUnitCostP: bigint("landed_unit_cost_p", { mode: "number" }),
    operationalShareP: bigint("operational_share_p", { mode: "number" }),
    batchNo: text("batch_no"),
    notes: text("notes"),
    legacyDoc: legacyDoc(),
    /** (S13) The folded line as printed — English name, Urdu name, brand, package — for the purchase search. Generated. */
    searchText: text("search_text").generatedAlwaysAs(
      sql`search_join(description_en_snapshot, description_snapshot, brand_snapshot, package_snapshot)`,
    ),
  },
  (t) => [
    index("purchase_items_purchase_idx").on(t.purchaseId, t.sortOrder),
    index("purchase_items_product_idx").on(t.productId, t.warehouseId),
    check("purchase_items_qty_chk", sql`${t.qtyMilli} > 0 AND ${t.receivedQtyMilli} >= 0 AND ${t.returnedQtyMilli} >= 0`),
    check("purchase_items_money_chk", sql`${t.unitPriceP} >= 0 AND ${t.discountP} >= 0 AND ${t.taxP} >= 0 AND ${t.lineTotalP} >= 0`),
    // Fix 2: a line discount cannot exceed the line's gross (same integer form as invoice_items_discount_chk).
    check("purchase_items_discount_chk", sql`1000 * ${t.discountP} <= ${t.unitPriceP} * ${t.qtyMilli} + 500`),
  ],
);

/* ── payments (S2 loads them; S3 builds the services on these tables) ─────
   party_id is polymorphic (a customer or a supplier id, per party_type), so
   it is not a foreign key — the importer and the CHECKs below guard it. */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    legacyId: legacyId(),
    direction: text("direction").notNull(), // IN | OUT
    partyType: text("party_type").notNull(), // CUSTOMER | SUPPLIER
    partyId: uuid("party_id").notNull(),
    isRefund: boolean("is_refund").notNull().default(false),
    amountP: bigint("amount_p", { mode: "number" }).notNull(),
    method: text("method"),
    reference: text("reference"),
    note: text("note"),
    paymentDate: date("payment_date").notNull(),
    status: text("status").notNull().default("POSTED"), // POSTED | REVERSED
    receiptNumber: text("receipt_number").notNull().unique(),
    receivedBy: text("received_by"),
    /** What was printed on the voucher, frozen at creation (legacy `partyNameSnapshot` etc., S4): a later rename of
     *  the shop does not change an old receipt. Receipts print these; search matches these AND the party's current name. */
    partyNameSnapshot: text("party_name_snapshot"),
    partyOwnerSnapshot: text("party_owner_snapshot"),
    regionSnapshot: text("region_snapshot"),
    createdAt: createdAt(),
    /** Who recorded / reversed the voucher (S3). Null on imported rows: the legacy app stored a display name, kept in `received_by`. */
    createdBy: uuid("created_by").references(() => users.id),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reverseReason: text("reverse_reason"),
    /** Client-chosen key that makes a create request safe to repeat (the legacy app had no guard against a double-clicked Save). */
    idempotencyKey: text("idempotency_key").unique(),
    legacyDoc: legacyDoc(),
    /* Folded text of each searchable field of the voucher — the legacy `build()` index, kept by Postgres itself
       (GENERATED ... STORED: no triggers, never stale, never written by the app). What a person may type to find a
       voucher: see apps/api/src/payments/payments.search.ts. The party's CURRENT text and the invoice numbers it was
       applied to live on customers / suppliers / regions / invoices / purchases (same kind of column). */
    searchNumber: text("search_number").generatedAlwaysAs(sql`search_join(receipt_number, search_compact(receipt_number))`),
    searchParty: text("search_party").generatedAlwaysAs(sql`search_join(party_name_snapshot, party_owner_snapshot, region_snapshot)`),
    searchReference: text("search_reference").generatedAlwaysAs(sql`search_join(reference, search_compact(reference))`),
    searchAmount: text("search_amount").generatedAlwaysAs(sql`search_amount_text(amount_p)`),
    searchDate: text("search_date").generatedAlwaysAs(sql`search_date_text(payment_date)`),
    searchOther: text("search_other").generatedAlwaysAs(
      sql`search_join(note, legacy_doc->>'description', method, received_by, CASE WHEN direction = 'IN' THEN 'Received from shop' WHEN party_type = 'CUSTOMER' THEN 'Paid to shop' ELSE 'Paid to supplier' END, CASE WHEN direction = 'IN' THEN 'receipt' WHEN party_type = 'CUSTOMER' THEN 'refund voucher' ELSE 'voucher' END, CASE WHEN status = 'REVERSED' THEN 'reversed cancelled ' || COALESCE(reverse_reason, '') END)`,
    ),
  },
  (t) => [
    check("payments_direction_chk", sql`${t.direction} IN ('IN', 'OUT')`),
    check("payments_party_type_chk", sql`${t.partyType} IN ('CUSTOMER', 'SUPPLIER')`),
    check("payments_status_chk", sql`${t.status} IN ('POSTED', 'REVERSED')`),
    index("payments_party_idx").on(t.partyType, t.partyId),
    // The payments list screen: newest business date first, then newest entry.
    index("payments_list_idx").on(t.paymentDate.desc(), t.createdAt.desc()),
  ],
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: id(),
    legacyId: legacyId(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    purchaseId: uuid("purchase_id").references(() => purchases.id),
    amountP: bigint("amount_p", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("payment_allocations_one_target_chk", sql`num_nonnulls(${t.invoiceId}, ${t.purchaseId}) = 1`),
    index("payment_allocations_payment_idx").on(t.paymentId),
    index("payment_allocations_invoice_idx").on(t.invoiceId),
    index("payment_allocations_purchase_idx").on(t.purchaseId),
  ],
);

export const returns = pgTable(
  "returns",
  {
    id: id(),
    legacyId: legacyId(),
    kind: text("kind").notNull(), // CUSTOMER | SUPPLIER
    partyId: uuid("party_id"),
    /** Customer returns only: the invoice the goods came back against. Feeds `Invoices.outstanding` (S3). */
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    returnNumber: text("return_number"),
    date: date("date").notNull(),
    /** creditAmount (customer return) or debitAmount (supplier return), paisa. */
    totalP: moneyP("total_p"),
    status: text("status").notNull().default("DRAFT"),
    /** Customer returns only: ADJUST_OUTSTANDING_BALANCE | CUSTOMER_CREDIT | REFUND | REPLACEMENT. */
    treatment: text("treatment"),
    /** REFUND treatment: the cash-out payment the return wrote. The legacy app links the two only by
     *  payment.reference == returnNumber plus a "Refund against return " note prefix; resolved at import. */
    refundPaymentId: uuid("refund_payment_id").references((): AnyPgColumn => payments.id),
    createdAt: createdAt(),
    legacyDoc: legacyDoc(),
  },
  (t) => [
    index("returns_return_number_idx").on(t.returnNumber),
    index("returns_invoice_idx").on(t.invoiceId),
  ],
);

/* ── ledger-feeding documents added by later legacy patch modules ─────────
   16-khata.js wraps Ledger.customer with account adjustments and 32-milling.js
   wraps Ledger.supplier with milling jobs, so both feed the balances S2 must
   reproduce. Headers only; milling items/stock stay deferred to M8. */
export const accountAdjustments = pgTable("account_adjustments", {
  id: id(),
  legacyId: legacyId(),
  adjustmentNumber: text("adjustment_number"),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id),
  date: date("date").notNull(),
  direction: text("direction").notNull(), // DEBIT (adds to what the shop owes) | CREDIT
  amountP: bigint("amount_p", { mode: "number" }).notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("POSTED"), // POSTED | REVERSED
  createdAt: createdAt(),
  legacyDoc: legacyDoc(),
});

export const millingJobs = pgTable("milling_jobs", {
  id: id(),
  legacyId: legacyId(),
  jobNumber: text("job_number"),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id), // the mill is a supplier
  date: date("date").notNull(),
  settle: text("settle"), // NET | FEE_ONLY
  receiveMode: text("receive_mode"), // AT_MILL | DELIVERED
  issuedValueP: bigint("issued_value_p", { mode: "number" }).notNull().default(0),
  receivedValueP: bigint("received_value_p", { mode: "number" }).notNull().default(0),
  feeAmountP: bigint("fee_amount_p", { mode: "number" }).notNull().default(0),
  status: text("status").notNull().default("POSTED"),
  createdAt: createdAt(),
  legacyDoc: legacyDoc(),
});
