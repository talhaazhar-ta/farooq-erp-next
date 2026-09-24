/**
 * REFERENCE IMPLEMENTATION of the legacy payment search (D:\projectFarooqAndCoTraders ... erp-upgrade):
 *   33-invoice-search.js  — `norm`/`joinN`/`compact`/`hasTerm`/`dateText`/`parse`/`toPaisa`
 *   11-search.js         — `normalize`
 *   38-payment-search.js — `build` / `currentPartyText` / `prepare` / `matcher` / `sortList` / `results`
 * ported LITERALLY (same steps, same order, same quirks) to run over the legacy-shaped backup JSON. It imports nothing
 * from the code under test — not the shared `foldSearch`, not `parseSearchQuery`, not the SQL — so when the endpoint and
 * this agree on the same ids in the same order for a table of queries, that is two independently built implementations
 * agreeing (CLAUDE.md rule 7/8).
 *
 * Differences from the legacy, all forced by running outside the browser and none by intent:
 *  - the Store `S` is a plain object of the backup's arrays, `custBy` / `supOf` / `regionTxt` read it directly;
 *  - lower-casing is per character (see fold.ts: no final-sigma context), which the corpus does not reach anyway;
 *  - amounts arrive in paisa for `min` / `max` (the API takes paisa; the legacy `toPaisa` parsed the box text).
 */

type Doc = Record<string, any>;

/* ── 11-search.js normalize ─────────────────────────────────────────── */
const DIGITS: Record<string, string> = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };
const LETTERS: Record<string, string> = { "ي": "ی", "ﻱ": "ی", "ئ": "ی", "ى": "ی", "ﻲ": "ی", "ك": "ک", "ﻙ": "ک", "ه": "ہ", "ة": "ہ", "ۃ": "ہ", "ھ": "ہ", "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ﺍ": "ا", "ؤ": "و", "ۀ": "ہ" };

export function normalize(s: unknown): string {
  if (s === null || s === undefined) return "";
  let out = String(s).toLowerCase();
  // a verbatim copy of the legacy class: it names the zero-width joiner as one of the marks it strips
  // eslint-disable-next-line no-misleading-character-class
  out = out.replace(/[\u064B-\u0652\u0670\u0640\u200c\u200d\u200e\u200f]/g, "");
  out = out.replace(/[٠-٩۰-۹]/g, (c) => DIGITS[c] || c);
  out = out.replace(/[يﻱئىﻲكﻙهةۃھأإآٱﺍؤۀ]/g, (c) => LETTERS[c] || c);
  out = out.replace(/[^\p{L}\p{N}]+/gu, " ");
  return out.replace(/\s+/g, " ").trim();
}

/* ── 33-invoice-search.js helpers ───────────────────────────────────── */
const SEP = "\u0001";
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const pad2 = (n: number) => (n < 10 ? "0" : "") + n;
const isoOf = (y: number, m: number, d: number) => y + "-" + pad2(m) + "-" + pad2(d);
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();
const labelDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)!;
  return m[3] + " " + MON3[+m[2]! - 1] + " " + m[1];
};

const norm = normalize;
function joinN(parts: unknown[]): string {
  const out: string[] = [];
  parts.forEach((p) => {
    const n = norm(p);
    if (n) out.push(n);
  });
  return out.join(SEP);
}
const compact = (s: unknown) => norm(s).replace(/ /g, "");

function hasTerm(hays: string[], t: string): boolean {
  const t2 = t.indexOf(" ") > -1 ? t.replace(/ /g, "") : "";
  for (let i = 0; i < hays.length; i++) {
    if (hays[i]!.indexOf(t) > -1 || (t2 && hays[i]!.indexOf(t2) > -1)) return true;
  }
  return false;
}

function dayRange(y: any, m: any, d: any, src: string, dayFirst?: boolean): any {
  y = +y; m = +m; d = +d;
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  const iso = isoOf(y, m, d);
  return { from: iso, to: iso, label: labelDate(iso), src, dayFirst: !!dayFirst };
}
function monthRange(y: any, m: any, src: string): any {
  y = +y; m = +m;
  if (y < 1990 || y > 2100 || m < 1 || m > 12) return null;
  return { from: isoOf(y, m, 1), to: isoOf(y, m, daysIn(y, m)), label: MON3[m - 1] + " " + y, src };
}
const monthNo = (word: string) => MON3.map((x) => x.toLowerCase()).indexOf(word.toLowerCase().slice(0, 3)) + 1;

export function parse(raw: unknown): { terms: string[]; dates: any[] } {
  let s = String(raw === null || raw === undefined ? "" : raw);
  const dates: any[] = [];
  s = s.replace(/[٠-٩۰-۹]/g, (c) => {
    const k = c.charCodeAt(0);
    return String(k >= 0x06f0 ? k - 0x06f0 : k - 0x0660);
  });
  // `build` declares one parameter per capture group, then `src`
  function take(re: RegExp, build: (...a: any[]) => any) {
    const groups = build.length - 1;
    s = s.replace(re, function (m: string, ...rest: any[]) {
      const args = rest.slice(0, groups);
      const r = build(...args, m.trim());
      if (!r) return m;
      dates.push(r);
      return " ";
    });
  }
  const MR = "(" + MONTH_RE + ")";
  take(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, (y, m, d, src) => dayRange(y, m, d, src));
  take(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g, (a, b, y, src) => dayRange(y, b, a, src, true) || dayRange(y, a, b, src, false));
  take(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*" + MR + "(?![a-z])\\.?,?[\\s-]*(\\d{4})\\b", "gi"), (d, mon, y, src) => dayRange(y, monthNo(mon), d, src));
  take(new RegExp("\\b" + MR + "(?![a-z])\\.?[\\s-]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s-]+(\\d{4})\\b", "gi"), (mon, d, y, src) => dayRange(y, monthNo(mon), d, src));
  take(new RegExp("\\b" + MR + "(?![a-z])\\.?,?[\\s-]*(\\d{4})\\b", "gi"), (mon, y, src) => monthRange(y, monthNo(mon), src));
  take(new RegExp("\\b(\\d{4})[\\s-]+" + MR + "(?![a-z])", "gi"), (y, mon, src) => monthRange(y, monthNo(mon), src));
  take(/(^|[\s,;])(\d{4})-(\d{1,2})(?=$|[\s,;])/g, (_pre, y, m, src) => monthRange(y, m, src));
  take(/(^|[\s,;])(\d{1,2})[/.](\d{4})(?=$|[\s,;])/g, (_pre, m, y, src) => monthRange(y, m, src));

  const terms = s.split(/\s+/).map(norm).filter(Boolean);
  return { terms, dates };
}

function dateText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  const mo = +m[2]!, d = +m[3]!;
  return joinN([iso, d + " " + MON3[mo - 1] + " " + m[1], MONTHS[mo - 1], pad2(d) + " " + m[2] + " " + m[1], d + " " + mo + " " + m[1]]);
}

/* ── 38-payment-search.js ───────────────────────────────────────────── */
export interface LegacyStore {
  payments: Doc[];
  paymentAllocations: Doc[];
  invoices: Doc[];
  purchases: Doc[];
  customers: Doc[];
  suppliers: Doc[];
  regions: Doc[];
}

export interface LegacyState {
  q?: string;
  scope?: string;
  /** rec | shops | sup | all */
  dir?: string;
  method?: string;
  /** legacy region id */
  region?: string;
  from?: string;
  to?: string;
  /** paisa */
  minP?: number;
  maxP?: number;
  sort?: string;
  /** an addition of S4's (the legacy had no status control) */
  status?: string;
}

const SCOPE_FIELD: Record<string, string> = { number: "number", reference: "reference", invoice: "invoice", amount: "amount", notes: "other" };

export const dirOf = (p: Doc) => (p.direction === "IN" ? "rec" : p.partyType === "CUSTOMER" ? "shops" : "sup");
export const groupOf = (p: Doc) => (p.status === "REVERSED" ? "rev" : dirOf(p));
const typeLabel = (p: Doc) => ({ rec: "Received from shop", shops: "Paid to shop", sup: "Paid to supplier" } as Record<string, string>)[dirOf(p)]!;

const toR = (p: number) => Math.round(p || 0) / 100;

export function createLegacySearch(S: LegacyStore) {
  const custById = new Map(S.customers.map((c) => [c.id, c]));
  const supById = new Map(S.suppliers.map((s) => [s.id, s]));
  const regById = new Map(S.regions.map((r) => [r.id, r]));
  const custBy = (id: string) => custById.get(id) || null;
  const supOf = (id: string) => supById.get(id) || null;
  const regionTxt = (id: string) => {
    const r = regById.get(id);
    return r ? r.ur + " " + r.en : "—";
  };

  /* build(): one normalised text index per payment */
  function build(): Record<string, any> {
    const out: Record<string, any> = {};
    const invById: Record<string, Doc> = {};
    const purById: Record<string, Doc> = {};
    const byPay: Record<string, Doc[]> = {};
    S.invoices.forEach((i) => (invById[i.id] = i));
    S.purchases.forEach((u) => (purById[u.id] = u));
    S.paymentAllocations.forEach((a) => (byPay[a.paymentId] = byPay[a.paymentId] || []).push(a));
    S.payments.forEach((p) => {
      const refs: string[] = [];
      let applied = 0;
      (byPay[p.id] || []).forEach((a) => {
        applied += a.amount || 0;
        const d = a.invoiceId ? invById[a.invoiceId] : purById[a.purchaseId];
        const no = d && (d.invoiceNumber || d.purchaseNumber);
        if (no) refs.push(no);
      });
      const total = toR(p.amount);
      const withPaisa = total % 1 ? [total.toFixed(2), Number(total).toLocaleString("en-US", { minimumFractionDigits: 2 })] : [];
      const e: any = {
        number: joinN([p.receiptNumber, compact(p.receiptNumber)]),
        party: joinN([p.partyNameSnapshot, p.partyOwnerSnapshot, p.regionSnapshot]),
        reference: joinN([p.reference, compact(p.reference)]),
        invoice: joinN(refs.reduce((a: string[], no) => a.concat([no, compact(no)]), [])),
        amount: joinN([String(total), Number(total).toLocaleString("en-US")].concat(withPaisa)),
        date: dateText(p.paymentDate),
        other: joinN([
          p.note, p.description, p.method, p.receivedBy, typeLabel(p),
          ({ rec: "receipt", shops: "refund voucher", sup: "voucher" } as Record<string, string>)[dirOf(p)],
          p.status === "REVERSED" ? "reversed cancelled " + (p.reverseReason || "") : "",
        ]),
        refs,
        onAccount: Math.max(0, p.amount - applied),
      };
      e.all = [e.number, e.party, e.reference, e.invoice, e.amount, e.date, e.other].filter(Boolean).join(SEP);
      out[p.id] = e;
    });
    return out;
  }
  const idx = build();

  function currentPartyText() {
    const memo: Record<string, string> = {};
    return (p: Doc) => {
      const key = p.partyType + ":" + p.partyId;
      if (memo[key] !== undefined) return memo[key]!;
      let t = "";
      if (p.partyType === "CUSTOMER") {
        const c = custBy(p.partyId);
        if (c) t = joinN([c.sh, c.ow, c.nameUr, c.ph, compact(c.ph), c.wa, c.legacyCode, regionTxt(c.region)]);
      } else {
        const s = supOf(p.partyId);
        if (s) t = joinN([s.co, s.cp, s.ph, compact(s.ph), s.lo]);
      }
      return (memo[key] = t);
    };
  }

  function prepare(state: LegacyState) {
    const p = parse(state.q);
    const scope = state.scope === "party" || SCOPE_FIELD[state.scope ?? ""] ? state.scope! : "all";
    const problems: string[] = [];
    let ranges: any[] | null = null;
    if (p.dates.length) ranges = p.dates;
    else if (state.from || state.to) {
      if (state.from && state.to && state.from > state.to) problems.push("The “From” date is after the “To” date, so no payment can match.");
      ranges = [{ from: state.from || null, to: state.to || null }];
    }
    const minP = state.minP ?? null;
    const maxP = state.maxP ?? null;
    if (minP !== null && maxP !== null && minP > maxP) problems.push("The minimum amount is above the maximum, so no payment can match.");
    return { p, scope, ranges, minP, maxP, problems };
  }

  function matcher(state: LegacyState, ignoreDirAndStatus = false) {
    const pr = prepare(state);
    const terms = pr.p.terms;
    const cur = (pr.scope === "all" || pr.scope === "party") && terms.length ? currentPartyText() : null;
    return (p: Doc) => {
      if (pr.problems.length) return false;
      if (!ignoreDirAndStatus) {
        if (state.dir && state.dir !== "all" && dirOf(p) !== state.dir) return false;
        if (state.status && p.status !== state.status) return false;
      }
      if (state.method && state.method !== "all" && p.method !== state.method) return false;
      if (state.region && state.region !== "all") {
        const c = p.partyType === "CUSTOMER" ? custBy(p.partyId) : null;
        if (!c || c.region !== state.region) return false;
      }
      if (pr.ranges) {
        const d = p.paymentDate;
        let ok = false;
        for (let k = 0; k < pr.ranges.length && !ok; k++) {
          const r = pr.ranges[k];
          ok = (!r.from || d >= r.from) && (!r.to || d <= r.to);
        }
        if (!ok) return false;
      }
      if (pr.minP !== null && p.amount < pr.minP) return false;
      if (pr.maxP !== null && p.amount > pr.maxP) return false;
      if (terms.length) {
        const e = idx[p.id];
        const hays = pr.scope === "all" ? [e.all, cur!(p)] : pr.scope === "party" ? [e.party, cur!(p)] : [e[SCOPE_FIELD[pr.scope]!]];
        for (let j = 0; j < terms.length; j++) if (!hasTerm(hays, terms[j]!)) return false;
      }
      return true;
    };
  }

  function sortList(list: Doc[], key: string | undefined) {
    // > 0 when a is newer than b (the legacy tie-break: date, createdAt, receipt number)
    function newer(a: Doc, b: Doc): number {
      if (a.paymentDate !== b.paymentDate) return a.paymentDate < b.paymentDate ? -1 : 1;
      const x = a.createdAt || "", y = b.createdAt || "";
      if (x !== y) return x < y ? -1 : 1;
      return String(a.receiptNumber || "") < String(b.receiptNumber || "") ? -1 : 1;
    }
    let cmp: (a: Doc, b: Doc) => number;
    if (key === "oldest") cmp = newer;
    else if (key === "high") cmp = (a, b) => b.amount - a.amount || newer(b, a);
    else if (key === "low") cmp = (a, b) => a.amount - b.amount || newer(b, a);
    else cmp = (a, b) => newer(b, a);
    return list.sort(cmp);
  }

  return {
    /** the matches in order (legacy `results(state).list`) */
    list(state: LegacyState): Doc[] {
      return sortList(S.payments.filter(matcher(state)), state.sort);
    },
    /** the facet groups: every filter except direction / status (what the API's `facets` says) */
    facets(state: LegacyState) {
      const sums: Record<string, { count: number; totalP: number }> = {
        received: { count: 0, totalP: 0 }, paidToShops: { count: 0, totalP: 0 }, paidToSuppliers: { count: 0, totalP: 0 }, reversed: { count: 0, totalP: 0 },
      };
      const name: Record<string, string> = { rec: "received", shops: "paidToShops", sup: "paidToSuppliers", rev: "reversed" };
      for (const p of S.payments.filter(matcher(state, true))) {
        const g = sums[name[groupOf(p)]!]!;
        g.count++;
        g.totalP += p.amount;
      }
      return sums;
    },
    describe(state: LegacyState) {
      const pr = prepare(state);
      return { terms: pr.p.terms, dates: pr.p.dates, problems: pr.problems };
    },
    /** what the CSV / list shows in "Applied to" */
    entry: (id: string) => idx[id],
  };
}
