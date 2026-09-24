import { foldSearch } from "./fold.js";

/**
 * What a person types into a search box, read the way the legacy ERP read it (33-invoice-search.js `parse`):
 * dates are pulled out and become a date FILTER; what is left becomes folded search words.
 *
 *   2026-09-12 · 2026/09/12            an ISO day
 *   12/09/2026 · 12-09-26              day first; month first only when that is the sole valid reading
 *   12 Sep 2026 · 12th September, 2026 · Sep 12, 2026
 *   Sep 2026 · 2026 Sep · 2026-09      a whole month
 *   09/2026                            a whole month — only as a word of its own (the tail of INV-2026-12 stays text)
 *
 * Arabic-Indic and Persian digits are read as digits first. A date that does not exist (31/02/2025) stays text.
 * Nothing here goes through `Date` or `toISOString()` (CLAUDE.md rule 6): a business date is a calendar day.
 */

const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTH_RE =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|" +
  "sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

export interface DateRange {
  /** Inclusive `YYYY-MM-DD` bounds; a single day has from === to. */
  from: string;
  to: string;
  /** The way the UI shows it: "12 Sep 2026" for a day, "Sep 2026" for a month. */
  label: string;
  /** The text the person typed. */
  src: string;
  /** True when a numeric date was read day / month / year. */
  dayFirst: boolean;
}

export interface ParsedQuery {
  /** Folded search words (AND, any order). */
  terms: string[];
  dates: DateRange[];
}

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;
const isoOf = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

function daysIn(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** "2026-09-12" → "12 Sep 2026" (the format of every legacy document). */
export function formatBusinessDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]} ${MON3[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

function dayRange(y0: number, m: number, d: number, src: string, dayFirst: boolean): DateRange | null {
  const y = y0 < 100 ? y0 + 2000 : y0;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  const iso = isoOf(y, m, d);
  return { from: iso, to: iso, label: formatBusinessDate(iso), src, dayFirst };
}

function monthRange(y: number, m: number, src: string): DateRange | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12) return null;
  return { from: isoOf(y, m, 1), to: isoOf(y, m, daysIn(y, m)), label: `${MON3[m - 1]} ${y}`, src, dayFirst: false };
}

const monthNo = (word: string): number => MON3.findIndex((x) => x.toLowerCase() === word.toLowerCase().slice(0, 3)) + 1;

export function parseSearchQuery(raw: unknown): ParsedQuery {
  let s = raw === null || raw === undefined ? "" : String(raw);
  const dates: DateRange[] = [];
  // Arabic-Indic (٠-٩) and Persian/Urdu (۰-۹) digits become 0-9 first, so a date typed on an Urdu keyboard is a date.
  s = s.replace(/[٠-٩۰-۹]/g, (c) => {
    const k = c.charCodeAt(0);
    return String(k >= 0x06f0 ? k - 0x06f0 : k - 0x0660);
  });

  /** Replaces every match that builds a real date with a space; a match that is not a real date stays text. */
  const take = (re: RegExp, groups: number, build: (g: string[], src: string) => DateRange | null): void => {
    s = s.replace(re, (...args: unknown[]) => {
      const m = args[0] as string;
      const g = args.slice(1, 1 + groups) as string[];
      const r = build(g, m.trim());
      if (!r) return m;
      dates.push(r);
      return " ";
    });
  };
  const MR = `(${MONTH_RE})`;
  const n = Number;

  // 2026-09-12 · 2026/09/12
  take(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, 3, ([y, m, d], src) => dayRange(n(y), n(m), n(d), src, false));
  // 12/09/2026 · 12-09-26 — day first; month first only when that is the sole valid reading
  take(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g, 3, ([a, b, y], src) =>
    dayRange(n(y), n(b), n(a), src, true) ?? dayRange(n(y), n(a), n(b), src, false),
  );
  // 12 Sep 2026 · 12th September, 2026
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*${MR}(?![a-z])\\.?,?[\\s-]*(\\d{4})\\b`, "gi"), 3, ([d, mon, y], src) =>
    dayRange(n(y), monthNo(mon!), n(d), src, false),
  );
  // Sep 12, 2026
  take(new RegExp(`\\b${MR}(?![a-z])\\.?[\\s-]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s-]+(\\d{4})\\b`, "gi"), 3, ([mon, d, y], src) =>
    dayRange(n(y), monthNo(mon!), n(d), src, false),
  );
  // Sep 2026 · September 2026
  take(new RegExp(`\\b${MR}(?![a-z])\\.?,?[\\s-]*(\\d{4})\\b`, "gi"), 2, ([mon, y], src) => monthRange(n(y), monthNo(mon!), src));
  // 2026 Sep
  take(new RegExp(`\\b(\\d{4})[\\s-]+${MR}(?![a-z])`, "gi"), 2, ([y, mon], src) => monthRange(n(y), monthNo(mon!), src));
  // 2026-09 · 09/2026 — only as a word of their own: the tail of a number such as INV-2026-12 must stay text
  take(/(^|[\s,;])(\d{4})-(\d{1,2})(?=$|[\s,;])/g, 3, ([, y, m], src) => monthRange(n(y), n(m), src));
  take(/(^|[\s,;])(\d{1,2})[/.](\d{4})(?=$|[\s,;])/g, 3, ([, m, y], src) => monthRange(n(y), n(m), src));

  const terms = s
    .split(/\s+/)
    .map((t) => foldSearch(t))
    .filter(Boolean);
  return { terms, dates };
}
