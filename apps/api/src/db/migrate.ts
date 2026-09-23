import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { APP_DB_ROLE, parseAppDbPassword, requireEnv } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = path.join(__dirname, "migrations");

/** Runs the checked-in migrations against `adminUrl`, then syncs the
 * farooq_app role's password to `appPassword` (never checked into git). */
export async function migrateDatabase(adminUrl: string, appPassword: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1 });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const escaped = appPassword.replace(/'/g, "''");
    await sql.unsafe(`ALTER ROLE ${APP_DB_ROLE} PASSWORD '${escaped}'`);
  } finally {
    await sql.end();
  }
}

async function main() {
  const adminUrl = requireEnv("DATABASE_URL");
  const appUrl = requireEnv("APP_DATABASE_URL");
  const appPassword = parseAppDbPassword(appUrl);
  await migrateDatabase(adminUrl, appPassword);
  console.log("Migrations applied; farooq_app password synced.");
}

// Only run when executed directly (`tsx src/db/migrate.ts`), not when
// imported by the test harness.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
