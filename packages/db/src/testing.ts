import type EmbeddedPostgres from "embedded-postgres";
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

/**
 * `embedded-postgres` registers an `async-exit-hook` the moment it is IMPORTED, and that hook's `beforeExit` handler calls
 * `process.exit(0)` (its `exit` handler even throws) — which silently turned a FAILING vitest run into exit code 0 (found in S8:
 * CI stayed green with 21 failed API tests). So it is imported only when it is really used (never in CI, which has a service
 * container), and once our teardown has stopped the cluster the listeners it added have nothing left to do: remove exactly
 * those, so vitest's own exit code stands.
 */
const EXIT_EVENTS = ["exit", "beforeExit", "SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK", "message"];
const listenersNow = (): Map<string, Set<unknown>> => new Map(EXIT_EVENTS.map((e) => [e, new Set((process as NodeJS.EventEmitter).listeners(e))]));

/** Starts (or attaches to) the test Postgres and migrates it. Returns a stop function. */
export async function startTestDatabase(): Promise<() => Promise<void>> {
  let pg: EmbeddedPostgres | undefined;
  let dataDir: string | undefined;
  let addedByEmbedded: (readonly [string, unknown])[] = [];
  if (!process.env.EXTERNAL_TEST_DATABASE_URL) {
    const before = listenersNow();
    const { default: EmbeddedPostgresClass } = await import("embedded-postgres");
    addedByEmbedded = EXIT_EVENTS.flatMap((e) => (process as NodeJS.EventEmitter).listeners(e).filter((l) => !before.get(e)!.has(l)).map((l) => [e, l] as const));
    dataDir = mkdtempSync(path.join(os.tmpdir(), "farooq-erp-pg-test-"));
    pg = new EmbeddedPostgresClass({
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
    for (const [event, listener] of addedByEmbedded) (process as NodeJS.EventEmitter).removeListener(event, listener as (...a: unknown[]) => void);
  };
}
