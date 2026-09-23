import { drizzle } from "drizzle-orm/postgres-js";
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
