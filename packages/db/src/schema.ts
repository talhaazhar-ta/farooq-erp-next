import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
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
    createdAt: createdAt(),
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

/* ── header-only transaction tables (line items are M2/M3 scope) ────────── */

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    legacyId: legacyId(),
    /** Drafts carry no number in the legacy app (stored as null). */
    invoiceNumber: text("invoice_number"),
    customerId: uuid("customer_id").references(() => customers.id),
    date: date("date").notNull(),
    totalP: moneyP("total_p"),
    /** The legacy status string, verbatim (DRAFT, CONFIRMED, PARTIALLY_PAID, PAID, CANCELLED, ...). */
    status: text("status").notNull().default("DRAFT"),
    createdAt: createdAt(),
    legacyDoc: legacyDoc(),
    /** Folded number and its compact form, so a payment can be found by the invoice it was applied to. Generated. */
    searchNumber: text("search_number").generatedAlwaysAs(sql`search_join(invoice_number, search_compact(invoice_number))`),
  },
  (t) => [
    index("invoices_invoice_number_idx").on(t.invoiceNumber),
    index("invoices_customer_idx").on(t.customerId),
  ],
);

export const purchases = pgTable(
  "purchases",
  {
    id: id(),
    legacyId: legacyId(),
    purchaseNumber: text("purchase_number"),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    date: date("date").notNull(),
    totalP: moneyP("total_p"),
    status: text("status").notNull().default("DRAFT"),
    createdAt: createdAt(),
    legacyDoc: legacyDoc(),
    /** Folded number and its compact form (see invoices.search_number). Generated. */
    searchNumber: text("search_number").generatedAlwaysAs(sql`search_join(purchase_number, search_compact(purchase_number))`),
  },
  (t) => [
    index("purchases_purchase_number_idx").on(t.purchaseNumber),
    index("purchases_supplier_idx").on(t.supplierId),
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
