import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
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

/* ── master data ──────────────────────────────────────────────────────── */

export const regions = pgTable("regions", {
  id: id(),
  legacyId: legacyId(),
  nameEn: text("name_en").notNull(),
  nameUr: text("name_ur"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const warehouses = pgTable("warehouses", {
  id: id(),
  legacyId: legacyId(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const products = pgTable("products", {
  id: id(),
  legacyId: legacyId(),
  name: text("name").notNull(),
  category: text("category"),
  unit: text("unit"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const suppliers = pgTable("suppliers", {
  id: id(),
  legacyId: legacyId(),
  companyName: text("company_name").notNull(),
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const customers = pgTable("customers", {
  id: id(),
  legacyId: legacyId(),
  shopName: text("shop_name").notNull(),
  ownerName: text("owner_name"),
  phone: text("phone"),
  regionId: uuid("region_id").references(() => regions.id),
  creditLimitP: bigint("credit_limit_p", { mode: "number" }).notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
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
  partyType: text("party_type"), // CUSTOMER | SUPPLIER | null
  partyId: uuid("party_id"),
  createdAt: createdAt(),
});

export const journalEntries = pgTable("journal_entries", {
  id: id(),
  date: date("date").notNull(),
  memo: text("memo"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
});

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
  (t) => [index("journal_lines_entry_id_idx").on(t.entryId)],
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
   Not a Postgres SEQUENCE object: the old app's `FDB.nextNumber` (01-db.js)
   increments a per-kind-per-year counter and consumes the number even if the
   parent record then fails to save, so gaps in the printed number are
   meaningful (an attempt happened) — matched here, not "fixed". Callers
   must increment under `SELECT ... FOR UPDATE` in the same transaction as
   the record they're numbering. */
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

export const invoices = pgTable("invoices", {
  id: id(),
  legacyId: legacyId(),
  customerId: uuid("customer_id").references(() => customers.id),
  date: date("date").notNull(),
  totalP: moneyP("total_p"),
  status: text("status").notNull().default("DRAFT"),
  createdAt: createdAt(),
});

export const purchases = pgTable("purchases", {
  id: id(),
  legacyId: legacyId(),
  supplierId: uuid("supplier_id").references(() => suppliers.id),
  date: date("date").notNull(),
  totalP: moneyP("total_p"),
  status: text("status").notNull().default("DRAFT"),
  createdAt: createdAt(),
});

export const returns = pgTable("returns", {
  id: id(),
  legacyId: legacyId(),
  kind: text("kind").notNull(), // CUSTOMER | SUPPLIER
  partyId: uuid("party_id"),
  date: date("date").notNull(),
  totalP: moneyP("total_p"),
  status: text("status").notNull().default("DRAFT"),
  createdAt: createdAt(),
});
