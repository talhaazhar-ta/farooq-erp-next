import EmbeddedPostgres from "embedded-postgres";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { migrateDatabase } from "./migrate.js";

/**
 * Shared test-database harness for apps/api and packages/import.
 *
 * Local/default: a throwaway embedded-postgres instance (no Docker needed).
 * CI: set EXTERNAL_TEST_DATABASE_URL to point at the Postgres service
 * container instead — the helper then skips spinning up embedded-postgres.
 * Either way tests connect through the same farooq_app least-privilege role.
 */
export const TEST_PG_PORT = 55433;
export const TEST_DB_NAME = "farooq_erp_test";
export const TEST_ADMIN_USER = "postgres";
export const TEST_ADMIN_PASSWORD = "postgres";
export const TEST_APP_PASSWORD = "test-app-password";

/**
 * Force UTF8: on Windows initdb otherwise picks the OS code page (WIN1252), which cannot store Urdu shop names
 * (found in S2 when the first Urdu customer name failed to insert). CI's Postgres image is UTF8 already.
 */
export const INITDB_FLAGS = ["--encoding=UTF8", "--locale=C"];

export const TEST_ADMIN_URL =
  process.env.EXTERNAL_TEST_DATABASE_URL ??
  `postgresql://${TEST_ADMIN_USER}:${TEST_ADMIN_PASSWORD}@127.0.0.1:${TEST_PG_PORT}/${TEST_DB_NAME}`;

export const TEST_APP_URL = (() => {
  const url = new URL(TEST_ADMIN_URL);
  url.username = "farooq_app";
  url.password = TEST_APP_PASSWORD;
  return url.toString();
})();

/** Starts (or attaches to) the test Postgres and migrates it. Returns a stop function. */
export async function startTestDatabase(): Promise<() => Promise<void>> {
  let pg: EmbeddedPostgres | undefined;
  let dataDir: string | undefined;
  if (!process.env.EXTERNAL_TEST_DATABASE_URL) {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "farooq-erp-pg-test-"));
    pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      port: TEST_PG_PORT,
      user: TEST_ADMIN_USER,
      password: TEST_ADMIN_PASSWORD,
      persistent: false,
      initdbFlags: INITDB_FLAGS,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(TEST_DB_NAME);
  }
  await migrateDatabase(TEST_ADMIN_URL, TEST_APP_PASSWORD);
  return async () => {
    await pg?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  };
}
