import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/**
 * Persistent local dev Postgres (no Docker needed) — separate from the
 * throwaway one `test/setup/global-setup.ts` spins up per test run. Data
 * survives restarts under packages/db/.embedded-postgres/dev (gitignored).
 *
 * Usage: `pnpm --filter @farooq/db db:dev`, then in another terminal
 * `pnpm --filter @farooq/api db:migrate && pnpm --filter @farooq/api db:seed`
 * and `pnpm --filter @farooq/api dev` / `pnpm --filter @farooq/web dev`.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_DB_DIR = path.join(__dirname, "../.embedded-postgres/dev");
const DEV_PORT = 54329;
const DEV_USER = "postgres";
const DEV_PASSWORD = "postgres";
const DEV_DB_NAME = "farooq_erp";

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DEV_DB_DIR,
    port: DEV_PORT,
    user: DEV_USER,
    password: DEV_PASSWORD,
    persistent: true,
    // UTF8, not the OS code page: WIN1252 clusters cannot store Urdu names (see testing.ts).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  // initialise() re-runs initdb, which fails on a data directory that
  // already has a cluster in it — only call it the first time.
  if (!existsSync(path.join(DEV_DB_DIR, "PG_VERSION"))) {
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DEV_DB_NAME);
  } catch {
    // already exists — fine, persistent instance from a previous run.
  }

  const adminUrl = `postgresql://${DEV_USER}:${DEV_PASSWORD}@127.0.0.1:${DEV_PORT}/${DEV_DB_NAME}`;
  console.log(`\nDev Postgres is up on :${DEV_PORT}.\n`);
  console.log(`DATABASE_URL=${adminUrl}`);
  console.log(`APP_DATABASE_URL=postgresql://farooq_app:<pick-a-password>@127.0.0.1:${DEV_PORT}/${DEV_DB_NAME}`);
  console.log(`\nPut these in apps/api/.env (see .env.example), then in another terminal:`);
  console.log(`  pnpm --filter @farooq/api db:migrate`);
  console.log(`  pnpm --filter @farooq/api db:seed`);
  console.log(`  pnpm --filter @farooq/api dev`);
  console.log(`  pnpm --filter @farooq/web dev`);
  console.log(`\nCtrl+C to stop this Postgres instance.\n`);

  const shutdown = async () => {
    console.log("\nStopping dev Postgres…");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
