import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { compactFold, foldSearch, joinFolded } from "@farooq/shared";

/**
 * decision 5 of S4: no Postgres extension, so `fold_search` is a plain SQL function generated from the same tables
 * as the JavaScript `foldSearch`. This test is the proof they are one function: EVERY Unicode code point goes
 * through both (the database is a C-locale UTF8 cluster, which is exactly where `[[:alpha:]]` would have silently
 * treated all of Urdu as punctuation), then a corpus of realistic strings, then the `search_*` helpers.
 *
 * If a Node upgrade brings a newer Unicode table this goes red on the code points it names: re-run
 * `node packages/shared/scripts/generate-fold-sql.mjs` and put the output into a new migration.
 */
let sql: ReturnType<typeof postgres>;
beforeAll(() => {
  sql = postgres(TEST_ADMIN_URL, { max: 2, onnotice: () => undefined });
});
afterAll(async () => {
  await sql.end();
});

const fold = async (s: string | null): Promise<string> => (await sql`SELECT fold_search(${s}) AS f`)[0]!.f as string;

describe("fold_search(text) ≡ foldSearch() — every code point", () => {
  it("agrees on every Unicode scalar value U+0001-U+10FFFF (one character each)", async () => {
    // What the database says: every non-empty result (a lone non-word character folds to '').
    const rows = await sql<{ cp: number; f: string }[]>`
      SELECT i AS cp, fold_search(chr(i)) AS f
      FROM generate_series(1, 1114111) AS i
      WHERE i NOT BETWEEN 55296 AND 57343 AND fold_search(chr(i)) <> ''`;
    const db = new Map(rows.map((r) => [r.cp, r.f]));

    const mismatches: string[] = [];
    let expectedNonEmpty = 0;
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const js = foldSearch(String.fromCodePoint(cp));
      if (js !== "") expectedNonEmpty++;
      const got = db.get(cp) ?? "";
      if (js !== got) mismatches.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}: js=${JSON.stringify(js)} sql=${JSON.stringify(got)}`);
      if (mismatches.length >= 20) break;
    }
    expect(mismatches).toEqual([]);
    expect(db.size).toBe(expectedNonEmpty);
    expect(db.size).toBeGreaterThan(100_000); // sanity: the loop really compared the letter/number space
  }, 120_000);

  it("agrees when the character sits between letters (a separator becomes exactly one space; letters stay glued)", async () => {
    const chars = [..."-_/.,;:!?()[]{}'\"`~@#$%^&*+=|\\<> \t\n  ​‌َّ۔،؟٫😀٣۳ıİΣσς"];
    for (const c of chars) {
      const s = `a${c}b${c}${c}c`;
      expect(await fold(s), JSON.stringify(s)).toBe(foldSearch(s));
    }
  });
});

const CORPUS: (string | null)[] = [
  null,
  "",
  "   ",
  "Ali Ahmad & Sons (Pvt.) Ltd.",
  "REC-2026-000031",
  "PV-2026-000002",
  "0300-1234567",
  "+92 300 1234567",
  "زم زم جنرل اسٹور",
  "زم زم",
  "كیا حال ہے؟",
  "کيا حال ھے؟",
  "ہاشم ھاشم هاشم",
  "مُحَمَّد",
  "آٹا أحمد إسلام مؤمن",
  "نمبر ۱۲۳ ٤٥٦ 789",
  "دکان، نمبر ۱۲",
  "Ab‌C‍D‎E",
  "İSTANBUL Ünïcode ÀÉÎ",
  "ΟΔΟΣ Σίσυφος",
  "Привет МИР",
  "日本語 テスト ｆｕｌｌｗｉｄｔｈ １２３",
  "🙂 emoji 🇵🇰 flag",
  "tab\tnew\nline\r\nmixed   spaces",
  "x²y ½ ①②③",
  "é combining ٔ hamza",
  "MiXeD کیس CASE 12 ۱۲",
  "-----",
  "a-b_c.d/e\\f",
];

describe("fold_search — a corpus of realistic strings (Urdu variants, diacritics, digits, punctuation, mixed scripts, empty / NULL)", () => {
  it.each(CORPUS.map((s, i) => [i, s] as const))("corpus #%i", async (_i, s) => {
    expect(await fold(s), JSON.stringify(s)).toBe(foldSearch(s));
  });
});

describe("the search_* helpers agree with the shared TypeScript", () => {
  it("search_compact ≡ compactFold", async () => {
    for (const s of CORPUS) {
      const got = (await sql`SELECT search_compact(${s}) AS v`)[0]!.v as string;
      expect(got, JSON.stringify(s)).toBe(compactFold(s));
    }
  });

  it("search_join (2, 3, 4, 5, 7 and 8 parts) ≡ joinFolded: empties dropped, parts folded, joined by chr(1)", async () => {
    const cases: (string | null)[][] = [
      ["Ali Ahmad", null],
      ["REC-2026-000031", "rec2026000031"],
      [null, null],
      ["زم زم", "٠٥/٠٣", "  "],
      ["Ali Ahmad", null, "", "REC-1"],
      ["a", "b", "c", "d", "e"],
      ["a", null, "İSTANBUL", "d", "", "f", "کيا"],
      ["a", "b", "c", "d", "e", "f", "g", "h"],
    ];
    for (const parts of cases) {
      const call = sql.unsafe(`SELECT search_join(${parts.map((_, i) => `$${i + 1}::text`).join(", ")}) AS v`, parts as string[]);
      expect((await call)[0]!.v, JSON.stringify(parts)).toBe(joinFolded(parts));
    }
  });

  /** The forms the legacy `build()` indexes an amount under (38-payment-search.js), written with the legacy's own calls. */
  const legacyAmountText = (amountP: number): string => {
    const total = Math.round(amountP) / 100;
    const withPaisa = total % 1 ? [total.toFixed(2), Number(total).toLocaleString("en-US", { minimumFractionDigits: 2 })] : [];
    return joinFolded([String(total), Number(total).toLocaleString("en-US"), ...withPaisa]);
  };
  it("search_amount_text ≡ the legacy amount forms (String, en-US grouping, toFixed(2), grouped with paisa)", async () => {
    const amounts = [0, 1, 5, 50, 99, 100, 101, 150, 1000, 100_000, 100_050, 100_005, 123_456, 1_234_500, 1_234_567, 99_999_999, 100_000_000, 123_456_789_012, 10_000_000_000_000];
    for (const a of amounts) {
      const got = (await sql`SELECT search_amount_text(${a}::bigint) AS v`)[0]!.v as string;
      expect(got, `amount ${a}`).toBe(legacyAmountText(a));
    }
  });

  const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const legacyDateText = (iso: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)!;
    const mo = +m[2]!;
    const d = +m[3]!;
    return joinFolded([iso, `${d} ${MON3[mo - 1]} ${m[1]}`, MONTHS[mo - 1], `${m[3]} ${m[2]} ${m[1]}`, `${d} ${mo} ${m[1]}`]);
  };
  it("search_date_text ≡ the legacy dateText (ISO, 'd Mon yyyy', month name, dd mm yyyy, d m yyyy)", async () => {
    for (const iso of ["2026-09-05", "2026-12-31", "2000-01-01", "2024-02-29", "2026-10-10"]) {
      const got = (await sql`SELECT search_date_text(${iso}::date) AS v`)[0]!.v as string;
      expect(got, iso).toBe(legacyDateText(iso));
    }
    expect((await sql`SELECT search_date_text(NULL::date) AS v`)[0]!.v).toBe("");
  });
});
