import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@farooq/db";
import { ImportError } from "./validate.js";
import { prepareImport, type Prepared } from "./prepare.js";

const {
  accountAdjustments,
  accounts,
  auditLog,
  companyProfile,
  customers,
  invoiceItems,
  invoices,
  journalEntries,
  journalLines,
  millingJobs,
  paymentAllocations,
  payments,
  products,
  purchases,
  regions,
  returns,
  sequences,
  stockLevels,
  stockMovements,
  suppliers,
  warehouses,
} = schema;

/**
 * The importer wipes business tables, so it only ever runs against a local database (CLAUDE.md: local-only
 * until a hosting decision is made). There is deliberately no override flag yet.
 */
export function assertLocalDatabaseUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ImportError("DATABASE_URL is not a valid connection URL.");
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new ImportError(
      `Refusing to import: database host '${host}' is not local. The importer wipes business tables and only runs against localhost / 127.0.0.1.`,
    );
  }
}

export interface ImportOptions {
  /** Admin/migration connection (TRUNCATE needs more than the app role has). Must be local. */
  databaseUrl: string;
  /** Recorded in the audit row, e.g. the backup file name. */
  sourceName?: string;
  /** Test hook: runs inside the transaction after everything is loaded, before commit. Throwing rolls back. */
  afterLoad?: () => void | Promise<void>;
}

export interface ImportResult {
  exportedAt: string;
  /** Rows loaded per table. */
  loaded: Record<string, number>;
  journalEntries: number;
  journalLines: number;
  /** Numbers of the invoices made by the old app's data migration (stock taken without SALE_OUT movements). */
  migratedInvoices: string[];
  warnings: string[];
}

/** Tables the importer owns and wipes. `users`, `sessions`, `role_permissions`, `audit_log` and `accounts` are never touched. */
export const WIPED_TABLES = [
  "journal_lines", "journal_entries", "payment_allocations", "returns", "payments", "account_adjustments",
  "milling_jobs", "stock_movements", "stock_levels", "invoice_items", "invoices", "purchases", "customers", "suppliers", "products", "warehouses", "regions", "sequences",
  "company_profile",
] as const;

async function insertChunked<T>(rows: T[], size: number, insert: (chunk: T[]) => PromiseLike<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/**
 * Validates the whole backup first (pure — any error leaves the database untouched), then, in ONE transaction:
 * wipes the business + ledger tables, loads every imported store, posts the journal, records an audit row.
 * Any error rolls the whole thing back.
 */
export async function runImport(backup: unknown, opts: ImportOptions): Promise<ImportResult> {
  assertLocalDatabaseUrl(opts.databaseUrl);
  const prepared: Prepared = prepareImport(backup); // throws ImportError before any connection is opened

  const client = postgres(opts.databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const db = drizzle(client, { schema });

    // The newest table the importer writes (migration 0005): if it is missing, the database is behind the code.
    const present = await client`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'stock_levels'`;
    if (present.length === 0) {
      throw new ImportError("The database is not migrated to the S6 schema (migration 0005) — run `pnpm --filter @farooq/api db:migrate` first.");
    }

    return await db.transaction(async (tx) => {
      const accountRows = await tx.select({ id: accounts.id, code: accounts.code }).from(accounts);
      const accountId = new Map(accountRows.map((a) => [a.code, a.id]));
      const missing = schema.ACCOUNT_CODES.filter((c) => !accountId.has(c));
      if (missing.length) throw new ImportError(`Control accounts missing (${missing.join(", ")}) — run the migrations.`);

      await tx.execute(dsql.raw(`TRUNCATE TABLE ${WIPED_TABLES.join(", ")}`));

      const r = prepared.rows;
      await insertChunked(r.regions, 500, (c) => tx.insert(regions).values(c));
      await insertChunked(r.warehouses, 500, (c) => tx.insert(warehouses).values(c));
      await insertChunked(r.products, 200, (c) => tx.insert(products).values(c));
      await insertChunked(r.customers, 200, (c) => tx.insert(customers).values(c));
      await insertChunked(r.suppliers, 200, (c) => tx.insert(suppliers).values(c));
      await insertChunked(r.invoices, 100, (c) => tx.insert(invoices).values(c));
      await insertChunked(r.invoiceItems, 200, (c) => tx.insert(invoiceItems).values(c));
      await insertChunked(r.stockLevels, 500, (c) => tx.insert(stockLevels).values(c));
      await insertChunked(r.stockMovements, 300, (c) => tx.insert(stockMovements).values(c));
      await insertChunked(r.purchases, 200, (c) => tx.insert(purchases).values(c));
      await insertChunked(r.payments, 200, (c) => tx.insert(payments).values(c));
      await insertChunked(r.paymentAllocations, 500, (c) => tx.insert(paymentAllocations).values(c));
      await insertChunked(r.returns, 200, (c) => tx.insert(returns).values(c));
      await insertChunked(r.accountAdjustments, 200, (c) => tx.insert(accountAdjustments).values(c));
      await insertChunked(r.millingJobs, 200, (c) => tx.insert(millingJobs).values(c));
      await insertChunked(r.sequences, 500, (c) => tx.insert(sequences).values(c));
      await insertChunked(r.companyProfile, 50, (c) => tx.insert(companyProfile).values(c));

      await insertChunked(prepared.journal, 500, (c) =>
        tx.insert(journalEntries).values(
          c.map((e) => ({
            id: e.id,
            date: e.date,
            memo: e.memo,
            sourceType: e.sourceType,
            sourceId: e.sourceId,
            ...(e.createdAt ? { createdAt: e.createdAt } : {}),
          })),
        ),
      );
      const lines = prepared.journal.flatMap((e) =>
        e.lines.map((l) => ({
          entryId: e.id,
          accountId: accountId.get(l.account)!,
          partyType: l.partyType ?? null,
          partyId: l.partyId ?? null,
          debitP: l.debitP,
          creditP: l.creditP,
        })),
      );
      await insertChunked(lines, 1000, (c) => tx.insert(journalLines).values(c));

      const loaded: Record<string, number> = {
        regions: r.regions.length,
        warehouses: r.warehouses.length,
        products: r.products.length,
        customers: r.customers.length,
        suppliers: r.suppliers.length,
        invoices: r.invoices.length,
        invoice_items: r.invoiceItems.length,
        stock_levels: r.stockLevels.length,
        stock_movements: r.stockMovements.length,
        purchases: r.purchases.length,
        payments: r.payments.length,
        payment_allocations: r.paymentAllocations.length,
        returns: r.returns.length,
        account_adjustments: r.accountAdjustments.length,
        milling_jobs: r.millingJobs.length,
        company_profile: r.companyProfile.length,
        sequences: r.sequences.length,
      };
      await tx.insert(auditLog).values({
        action: "IMPORT",
        entity: "legacy-backup",
        entityId: opts.sourceName ?? null,
        after: {
          source: opts.sourceName ?? null,
          exportedAt: prepared.exportedAt,
          loaded,
          journalEntries: prepared.journal.length,
          journalLines: lines.length,
          migratedInvoices: prepared.migratedInvoices,
          storeCounts: prepared.storeCounts,
        },
      });

      await opts.afterLoad?.();

      return {
        exportedAt: prepared.exportedAt,
        loaded,
        journalEntries: prepared.journal.length,
        journalLines: lines.length,
        migratedInvoices: prepared.migratedInvoices,
        warnings: prepared.warnings,
      };
    });
  } finally {
    await client.end();
  }
}
