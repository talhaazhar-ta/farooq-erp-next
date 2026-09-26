import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The REAL nightly backups the local-only proofs run on (S14). One place, so no test picks "the newest" by date again.
 *
 * Why: on 2026-09-25 the client wiped the live ERP's test data (transactions, audit log, counters gone; shops / products / suppliers /
 * regions / warehouses / settings kept, cached balances zeroed). From the first post-wipe nightly on, "the two newest backups" would have
 * been near-empty, and every real-data proof (balances, invoices, purchases, average cost, search parity) would have gone trivially green.
 * So the proofs are pinned by NAME to the last two nightlies before the wipe, and the newest nightly is only an extra "current" dataset.
 *
 * The backups are business data: gitignored under `/data/`, never in CI, never printed beyond counts.
 */

export interface RealBackupSpec {
  /** Short name in test titles. */
  label: string;
  /** The nightly's file name under `data/`. */
  file: string;
  /**
   * The least each legacy store must hold — the real counts of that nightly. A pinned dataset that has fewer rows than this is a
   * broken / replaced file, and its test FAILS instead of passing on an empty dataset.
   */
  minimums: Readonly<Record<string, number>>;
}

/** The last two nightlies before the 2026-09-25 wipe. `v710` is byte-identical (bar `exportedAt`) to the pre-wipe snapshot `business-20260925-175016-v710-f893.json`. */
export const PRE_WIPE_BACKUPS: readonly RealBackupSpec[] = [
  {
    label: "v692",
    file: "business-20260923-210002-v692-19fd.json",
    minimums: { products: 139, customers: 409, suppliers: 35, inventory: 15, stockMovements: 48, invoices: 17, invoiceItems: 18, purchases: 5, purchaseItems: 6, payments: 20 },
  },
  {
    label: "v710",
    file: "business-20260924-210002-v710-449d.json",
    minimums: { products: 139, customers: 409, suppliers: 35, inventory: 16, stockMovements: 50, invoices: 18, invoiceItems: 19, purchases: 5, purchaseItems: 6, payments: 21 },
  },
];

export interface RealBackupRef {
  label: string;
  file: string;
  path: string;
  /** false = the "current" extra dataset: it must import and reconcile, nothing more (it may be near-empty). */
  pinned: boolean;
  minimums: Readonly<Record<string, number>>;
}

/** `<repo>/data` — this file sits in packages/db/src (or packages/db/dist). */
export const REAL_BACKUP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");

const versionOf = (file: string): number => Number(/-v(\d+)-/.exec(file)?.[1] ?? 0);

/**
 * The pinned datasets that exist on this machine (in date order) and the newest nightly that is NEWER than the last pinned one (by its `-vNNN-`
 * data version — so a later copy of the same data, like the pre-wipe snapshot, is never taken for "current"). Nothing to run = empty.
 */
export function realBackups(dir: string = REAL_BACKUP_DIR): { pinned: RealBackupRef[]; current: RealBackupRef | null; all: RealBackupRef[] } {
  const present = existsSync(dir) ? readdirSync(dir).filter((f) => /^business-.*\.json$/.test(f)) : [];
  const pinned = PRE_WIPE_BACKUPS.filter((s) => present.includes(s.file)).map((s) => ({ ...s, path: path.join(dir, s.file), pinned: true }));
  const lastPinnedVersion = Math.max(...PRE_WIPE_BACKUPS.map((s) => versionOf(s.file)));
  const newest = present.filter((f) => versionOf(f) > lastPinnedVersion).sort().slice(-1)[0];
  const current: RealBackupRef | null = newest ? { label: "current", file: newest, path: path.join(dir, newest), pinned: false, minimums: {} } : null;
  return { pinned, current, all: current ? [...pinned, current] : pinned };
}

/** Empty list = the backup holds at least the minimum rows in every store. Otherwise one line per store that is short. */
export function minimumCountProblems(data: Record<string, unknown[] | undefined>, minimums: Readonly<Record<string, number>>): string[] {
  return Object.entries(minimums).flatMap(([store, min]) => {
    const have = data[store]?.length ?? 0;
    return have >= min ? [] : [`${store}: ${have} rows, a pinned real backup holds at least ${min}`];
  });
}
