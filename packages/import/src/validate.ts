import {
  DEFERRED_STORES,
  FIELD_CLASSES,
  IGNORED_STORES,
  IMPORTED_STORES,
  knownFields,
  type ImportedStore,
} from "./classification.js";

/** Anything the importer refuses to guess about. The message always names the store (and field where it applies). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

// raw legacy JSON documents
export type Doc = Record<string, any>;

export interface Backup {
  format: string;
  formatVersion: number;
  exportedAt: string;
  counts?: Record<string, number>;
  data: Record<string, Doc[]>;
  [k: string]: unknown;
}

/** `customers[id=abc]` — legacy ids are opaque strings, safe to print. */
export function where(store: string, doc: Doc): string {
  const id = doc.id ?? doc.k ?? "?";
  return `${store}[id=${String(id)}]`;
}

/* ── envelope + store + field classification ──────────────────────────── */

export function checkEnvelope(raw: unknown): Backup {
  if (!raw || typeof raw !== "object") throw new ImportError("Backup is not a JSON object.");
  const b = raw as Record<string, unknown>;
  if (b.format !== "farooq-co-erp-backup") {
    throw new ImportError(`Unexpected backup format ${JSON.stringify(b.format)} (expected "farooq-co-erp-backup").`);
  }
  if (b.formatVersion !== 1) {
    throw new ImportError(`Unsupported backup formatVersion ${JSON.stringify(b.formatVersion)} (expected 1).`);
  }
  if (typeof b.exportedAt !== "string") throw new ImportError("Backup has no exportedAt.");
  if (!b.data || typeof b.data !== "object") throw new ImportError("Backup has no data section.");
  const data = b.data as Record<string, unknown>;
  for (const [store, docs] of Object.entries(data)) {
    if (!Array.isArray(docs)) throw new ImportError(`Store '${store}' is not an array.`);
  }
  const counts = b.counts as Record<string, number> | undefined;
  if (counts) {
    for (const [store, docs] of Object.entries(data)) {
      const declared = counts[store];
      if (declared !== undefined && declared !== (docs as unknown[]).length) {
        throw new ImportError(
          `Store '${store}': backup counts says ${declared} but the file holds ${(docs as unknown[]).length} documents.`,
        );
      }
    }
  }
  return b as unknown as Backup;
}

export type StoreClass = "imported" | "deferred" | "ignored";

export function classifyStore(store: string): StoreClass | null {
  const lists: [StoreClass, object][] = [
    ["imported", IMPORTED_STORES],
    ["deferred", DEFERRED_STORES],
    ["ignored", IGNORED_STORES],
  ];
  const hits = lists.filter(([, l]) => store in l).map(([c]) => c);
  if (hits.length > 1) throw new ImportError(`Store '${store}' is classified more than once (${hits.join(", ")}).`);
  return hits[0] ?? null;
}

/** Aborts on any store that is in none of the three lists, or any unclassified field on an imported store. */
export function checkClassification(data: Record<string, Doc[]>): void {
  for (const store of Object.keys(data)) {
    if (classifyStore(store) === null) {
      throw new ImportError(
        `Unknown store '${store}' in the backup: classify it in packages/import/src/classification.ts (imported / deferred / ignored) before importing. Nothing was written.`,
      );
    }
  }
  for (const store of Object.keys(IMPORTED_STORES) as ImportedStore[]) {
    const known = knownFields(store);
    for (const doc of data[store] ?? []) {
      for (const key of Object.keys(doc)) {
        if (!known.has(key)) {
          throw new ImportError(
            `Store '${store}' has an unclassified field '${key}' (on ${where(store, doc)}): classify it in packages/import/src/classification.ts (mapped / docOnly / ignored) before importing. Nothing was written.`,
          );
        }
      }
    }
  }
}

/** Sanity-checks the classification tables themselves (each imported store has a field class). */
export function assertClassificationComplete(): void {
  for (const store of Object.keys(IMPORTED_STORES)) {
    if (!(store in FIELD_CLASSES)) throw new ImportError(`Imported store '${store}' has no field classification.`);
    classifyStore(store);
  }
  for (const store of [...Object.keys(DEFERRED_STORES), ...Object.keys(IGNORED_STORES)]) classifyStore(store);
}

/* ── value validators: each names store[id].field on failure ───────────── */

function fail(store: string, doc: Doc, key: string, why: string): never {
  throw new ImportError(`${where(store, doc)}.${key}: ${why}`);
}

export function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null;
}

export function reqStr(store: string, doc: Doc, key: string): string {
  const v = doc[key];
  if (typeof v !== "string" || v.trim() === "") fail(store, doc, key, "expected a non-empty string");
  return v as string;
}

/** Optional descriptor: absent/null/'' -> null. A non-string value aborts. */
export function optStr(store: string, doc: Doc, key: string): string | null {
  const v = doc[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") fail(store, doc, key, `expected a string, got ${typeof v}`);
  return v as string;
}

export function optBool(store: string, doc: Doc, key: string, fallback: boolean): boolean {
  const v = doc[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") fail(store, doc, key, `expected a boolean, got ${typeof v}`);
  return v as boolean;
}

/** Money is integer paisa: a non-integer / non-finite / negative value aborts (CLAUDE.md rule 5). */
export function paisa(store: string, doc: Doc, key: string, opts: { signed?: boolean; optional?: boolean } = {}): number {
  const v = doc[key];
  if (v === undefined || v === null) {
    if (opts.optional) return 0;
    fail(store, doc, key, "money field is missing");
  }
  if (typeof v !== "number" || !Number.isFinite(v)) fail(store, doc, key, `money must be a finite number, got ${JSON.stringify(v)}`);
  if (!Number.isSafeInteger(v)) fail(store, doc, key, `money must be an integer number of paisa, got ${v}`);
  if (!opts.signed && (v as number) < 0) fail(store, doc, key, `money must not be negative, got ${v}`);
  return v as number;
}

/** A `YYYY-MM-DD` business date, validated as a real calendar date — never routed through toISOString (rule 6). */
export function isoDate(store: string, doc: Doc, key: string): string {
  const v = doc[key];
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(store, doc, key, `expected a YYYY-MM-DD date, got ${JSON.stringify(v)}`);
  const s = v as string;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    fail(store, doc, key, `not a real calendar date: ${s}`);
  }
  return s;
}

export function optIsoDate(store: string, doc: Doc, key: string): string | null {
  const v = doc[key];
  if (v === undefined || v === null || v === "") return null;
  return isoDate(store, doc, key);
}

/** A UTC ISO timestamp (`createdAt`); absent -> null. */
export function optTimestamp(store: string, doc: Doc, key: string): Date | null {
  const v = doc[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) fail(store, doc, key, `expected an ISO timestamp, got ${JSON.stringify(v)}`);
  const t = new Date(v as string);
  if (Number.isNaN(t.getTime())) fail(store, doc, key, `not a valid timestamp: ${v}`);
  return t;
}

export function oneOf<T extends string>(store: string, doc: Doc, key: string, allowed: readonly T[]): T {
  const v = doc[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    fail(store, doc, key, `unknown value ${JSON.stringify(v)} (known: ${allowed.join(", ")})`);
  }
  return v as T;
}

export function optOneOf<T extends string>(store: string, doc: Doc, key: string, allowed: readonly T[]): T | null {
  const v = doc[key];
  if (v === undefined || v === null || v === "") return null;
  return oneOf(store, doc, key, allowed);
}

export function integer(store: string, doc: Doc, key: string, min = 0): number {
  const v = doc[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) fail(store, doc, key, `expected an integer >= ${min}, got ${JSON.stringify(v)}`);
  return v as number;
}
