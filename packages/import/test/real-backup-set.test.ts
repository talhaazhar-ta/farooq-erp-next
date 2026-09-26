import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PRE_WIPE_BACKUPS, minimumCountProblems, realBackups } from "@farooq/db/testing";

/**
 * S14 rule 3: the real-data proofs are pinned to NAMED pre-wipe backups. This is the part of that machinery that needs no real data, so it runs
 * everywhere (CI included): the file names, which file is "current", and that a near-empty dataset can never satisfy a pinned one.
 */
const tmp = mkdtempSync(path.join(os.tmpdir(), "farooq-real-backup-set-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const touch = (dir: string, ...names: string[]) => names.forEach((n) => writeFileSync(path.join(dir, n), "{}"));
const dirWith = (...names: string[]) => {
  const d = mkdtempSync(path.join(tmp, "d-"));
  touch(d, ...names);
  return d;
};

const V692 = "business-20260923-210002-v692-19fd.json";
const V710 = "business-20260924-210002-v710-449d.json";
const SNAPSHOT_V710 = "business-20260925-175016-v710-f893.json"; // the pre-wipe snapshot: the same data as V710, dated later
const V713 = "business-20260925-210002-v713-7eee.json"; // the first post-wipe nightly

describe("the named reference set", () => {
  it("is the last two nightlies before the 2026-09-25 wipe, each with the counts it really holds", () => {
    expect(PRE_WIPE_BACKUPS.map((b) => [b.label, b.file])).toEqual([["v692", V692], ["v710", V710]]);
    expect(PRE_WIPE_BACKUPS[0]!.minimums).toMatchObject({ customers: 409, suppliers: 35, invoices: 17, invoiceItems: 18, purchases: 5, payments: 20 });
    expect(PRE_WIPE_BACKUPS[1]!.minimums).toMatchObject({ invoices: 18, invoiceItems: 19, purchases: 5, purchaseItems: 6, payments: 21, stockMovements: 50 });
  });
});

describe("realBackups(dir): pinned by name, never 'the newest'", () => {
  it("newer files never displace the pinned ones: with the wipe's backups around, the pinned two are still v692 and v710", () => {
    const r = realBackups(dirWith(V692, V710, V713, "business-20260926-210002-v714-aaaa.json", "business-20260927-210002-v715-bbbb.json"));
    expect(r.pinned.map((p) => p.file)).toEqual([V692, V710]);
    expect(r.pinned.every((p) => p.pinned && Object.keys(p.minimums).length > 0)).toBe(true);
    expect(r.current).toMatchObject({ file: "business-20260927-210002-v715-bbbb.json", pinned: false, minimums: {} }); // the newest later nightly, with no minimum
    expect(r.all.map((p) => p.label)).toEqual(["v692", "v710", "current"]);
  });

  it("a later COPY of the same data (the pre-wipe snapshot, v710) is not 'current'; with nothing newer than v710 the current slot is empty", () => {
    const r = realBackups(dirWith(V692, V710, SNAPSHOT_V710));
    expect(r.current).toBeNull();
    expect(r.all.map((p) => p.file)).toEqual([V692, V710]);
  });

  it("the first post-wipe nightly is the current dataset", () => {
    expect(realBackups(dirWith(V692, V710, V713)).current?.file).toBe(V713);
  });

  it("a machine with only the post-wipe backup has NO pinned dataset (the proofs skip; they never quietly run on the empty one)", () => {
    const r = realBackups(dirWith(V713));
    expect(r.pinned).toEqual([]);
    expect(r.current?.file).toBe(V713);
  });

  it("no data directory at all: nothing", () => {
    expect(realBackups(path.join(tmp, "does-not-exist"))).toEqual({ pinned: [], current: null, all: [] });
  });
});

describe("minimumCountProblems: a pinned dataset can never pass while empty", () => {
  const v710 = PRE_WIPE_BACKUPS[1]!.minimums;
  const rows = (n: number) => Array.from({ length: n }, () => ({}));
  const full = Object.fromEntries(Object.entries(v710).map(([k, n]) => [k, rows(n)]));

  it("nothing wrong when every store holds at least its minimum", () => {
    expect(minimumCountProblems(full, v710)).toEqual([]);
    expect(minimumCountProblems({ ...full, invoices: rows(500) }, v710)).toEqual([]);
  });

  it("the post-wipe shape (shops and suppliers kept, no transactions) is refused, naming every store that is short", () => {
    const wiped = { ...full, invoices: [], invoiceItems: [], purchases: [], purchaseItems: [], payments: [], stockMovements: [], inventory: [] };
    const problems = minimumCountProblems(wiped, v710);
    expect(problems).toContain("invoices: 0 rows, a pinned real backup holds at least 18");
    expect(problems).toContain("purchases: 0 rows, a pinned real backup holds at least 5");
    expect(problems).toHaveLength(7);
  });

  it("one row short is short; a store missing from the backup counts as 0; the current dataset (no minimums) is never refused", () => {
    expect(minimumCountProblems({ ...full, payments: rows(20) }, v710)).toEqual(["payments: 20 rows, a pinned real backup holds at least 21"]);
    expect(minimumCountProblems({}, { invoices: 1 })).toEqual(["invoices: 0 rows, a pinned real backup holds at least 1"]);
    expect(minimumCountProblems({}, {})).toEqual([]);
  });
});
