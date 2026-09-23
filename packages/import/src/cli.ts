import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runImport } from "./load.js";
import { exitCodeFor, formatReport, localStamp, reconcile } from "./reconcile.js";
import { checkEnvelope, ImportError } from "./validate.js";

/**
 * pnpm --filter @farooq/import import <backup.json>
 *
 * Reads a legacy `farooq-co-erp-backup` JSON FILE (never a live database — CLAUDE.md rule 3), loads it into the
 * local Postgres named by DATABASE_URL, then prints the reconciliation report and writes
 * data/reconciliation-<timestamp>.json (gitignored). Exit code is non-zero if anything differs.
 */
async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: pnpm --filter @farooq/import import <backup.json>   (DATABASE_URL must point at a LOCAL, migrated Postgres)");
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (admin/migration connection to a local Postgres).");
    return 2;
  }

  const abs = path.resolve(process.cwd(), file);
  const backup = checkEnvelope(JSON.parse(readFileSync(abs, "utf8")));
  console.log(`Importing ${path.basename(abs)} (exported ${backup.exportedAt}) …`);

  const result = await runImport(backup, { databaseUrl, sourceName: path.basename(abs) });
  console.log(`Loaded: ${Object.entries(result.loaded).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  console.log(`Journal: ${result.journalEntries} entries, ${result.journalLines} lines`);
  for (const w of result.warnings) console.log(`warning: ${w}`);

  const report = await reconcile(backup, databaseUrl);
  console.log("");
  console.log(formatReport(report));

  const dataDir = process.env.RECONCILIATION_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
  mkdirSync(dataDir, { recursive: true });
  const out = path.join(dataDir, `reconciliation-${localStamp()}.json`);
  writeFileSync(out, JSON.stringify({ source: path.basename(abs), import: result, report }, null, 2));
  console.log(`\nReport written to ${out}`);
  return exitCodeFor(report);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof ImportError) console.error(`IMPORT ABORTED — ${err.message}`);
    else console.error(err);
    process.exitCode = 1;
  });
