import EmbeddedPostgres from "embedded-postgres";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { migrateDatabase } from "../../src/db/migrate.js";
import { TEST_ADMIN_PASSWORD, TEST_ADMIN_URL, TEST_APP_PASSWORD, TEST_DB_NAME, TEST_PG_PORT } from "./db-config.js";

let pg: EmbeddedPostgres | undefined;
let dataDir: string | undefined;

export async function setup(): Promise<void> {
  if (!process.env.EXTERNAL_TEST_DATABASE_URL) {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "farooq-erp-pg-test-"));
    pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      port: TEST_PG_PORT,
      user: "postgres",
      password: TEST_ADMIN_PASSWORD,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(TEST_DB_NAME);
  }
  await migrateDatabase(TEST_ADMIN_URL, TEST_APP_PASSWORD);
}

export async function teardown(): Promise<void> {
  await pg?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
