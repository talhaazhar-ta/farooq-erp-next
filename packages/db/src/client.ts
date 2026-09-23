import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * The app connects as the least-privilege `APP_DATABASE_URL` role (see
 * migration 0001_balance_trigger_and_grants.sql), never as the migration
 * role. Falls back to `DATABASE_URL` only for local convenience if
 * `APP_DATABASE_URL` isn't set — never do that in CI or prod.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return { client, db: drizzle(client, { schema }) };
}

export type Db = ReturnType<typeof createDb>["db"];

/** The transaction handle drizzle passes to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Either the pool (`Db`) or an open transaction (`Tx`): read helpers take this so they work inside and outside one. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
