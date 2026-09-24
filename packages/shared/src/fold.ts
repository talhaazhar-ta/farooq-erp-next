/**
 * Search folding — a port of the legacy `normalize` (11-search.js, used by every search box of the old ERP).
 *
 * Urdu is written several ways for the same word (ی/ي/ى, ک/ك, ہ/ه/ة/ھ, the alef forms), with optional
 * diacritics and joiners, and digits arrive both Arabic-Indic (٠-٩), Persian (۰-۹) and Latin. Everything is
 * folded to one form before two strings are compared, so "زم زم" typed any of the usual ways finds Zam Zam.
 *
 * The SQL function `fold_search(text)` (migration 0004) implements exactly the same folding, so the database
 * can search without any extension (no pg_trgm / unaccent — the embedded test Postgres may not have them). A
 * parity test feeds every BMP code point through both and demands identical output.
 *
 * Steps, in the legacy order: lower-case → strip harakat / tatweel / zero-width marks → fold digits → fold
 * letter variants → every run of non-letter, non-digit becomes one space → trim.
 *
 * Deviation from the legacy (listed in STATUS): lower-casing is done one character at a time, so Greek final
 * sigma is not context-sensitive. Irrelevant to Urdu/English data; it is what lets SQL and JS agree.
 */

/**
 * Characters removed outright, as code-point ranges: Arabic diacritics (U+064B-0652), superscript alef (U+0670),
 * tatweel (U+0640), and ZWNJ / ZWJ / LRM / RLM (U+200C-200F). Built from numbers so the invisible characters are named,
 * not pasted; scripts/generate-fold-sql.mjs lists the same ranges for the SQL twin.
 */
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x064b, 0x0652],
  [0x0670, 0x0670],
  [0x0640, 0x0640],
  [0x200c, 0x200f],
];
export const STRIPPED_MARKS = new RegExp(`[${STRIPPED_RANGES.map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("")}]`, "g");

/** Arabic-Indic (٠-٩) and Persian/Urdu (۰-۹) digits → Latin. */
export const DIGIT_MAP: Readonly<Record<string, string>> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** Letter variants → the one form the folded text uses. */
export const LETTER_MAP: Readonly<Record<string, string>> = {
  "ي": "ی", "ﻱ": "ی", "ئ": "ی", "ى": "ی", "ﻲ": "ی",
  "ك": "ک", "ﻙ": "ک",
  "ه": "ہ", "ة": "ہ", "ۃ": "ہ", "ھ": "ہ",
  "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ﺍ": "ا",
  "ؤ": "و", "ۀ": "ہ",
};

const DIGIT_RE = /[٠-٩۰-۹]/g;
const LETTER_RE = /[يﻱئىﻲكﻙهةۃھأإآٱﺍؤۀ]/g;
const NOT_WORD_RE = /[^\p{L}\p{N}]+/gu;

/** The folded form of any value; null / undefined fold to "". */
export function foldSearch(value: unknown): string {
  if (value === null || value === undefined) return "";
  let out = "";
  for (const ch of String(value)) out += ch.toLowerCase(); // per character: no context-sensitive final sigma
  out = out.replace(STRIPPED_MARKS, "");
  out = out.replace(DIGIT_RE, (c) => DIGIT_MAP[c] ?? c);
  out = out.replace(LETTER_RE, (c) => LETTER_MAP[c] ?? c);
  out = out.replace(NOT_WORD_RE, " ");
  return out.replace(/\s+/g, " ").trim();
}

/** Folded, with the spaces removed too — "REC-2026-000031" → "rec2026000031" (finds a number typed without hyphens). */
export const compactFold = (value: unknown): string => foldSearch(value).replace(/ /g, "");

/** Separates the parts of one indexed field. A search word can never contain it, so a word never straddles two parts. */
export const SEARCH_SEPARATOR = "\u0001";

/** Every non-empty part folded, then joined with the separator (legacy `joinN`). */
export function joinFolded(parts: readonly unknown[]): string {
  const out: string[] = [];
  for (const p of parts) {
    const f = foldSearch(p);
    if (f) out.push(f);
  }
  return out.join(SEARCH_SEPARATOR);
}

/**
 * A folded term matches a folded field when the field contains it — or, for a term of several words, when the
 * field contains it with the spaces removed ("zam zam" ⇄ "zamzam", "0300 1234567" ⇄ a phone stored without a
 * dash). A field is a list because "everything" also looks at the party's *current* details.
 */
export function hasTerm(fields: readonly string[], term: string): boolean {
  const squeezed = term.includes(" ") ? term.replace(/ /g, "") : "";
  for (const f of fields) {
    if (f.includes(term) || (squeezed !== "" && f.includes(squeezed))) return true;
  }
  return false;
}
