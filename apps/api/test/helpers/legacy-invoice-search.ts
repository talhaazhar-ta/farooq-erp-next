/**
 * REFERENCE IMPLEMENTATION of the legacy invoice search (D:\projectFarooqAndCoTraders ... erp-upgrade/33-invoice-search.js):
 * `build` / `currentCustomerText` / `prepare` / `matcher` / `sortList` / `hitsFor` / `describe`, ported LITERALLY (same steps,
 * same order, same quirks) to run over the legacy-shaped backup JSON, plus what 05-ui-builder.js §37 draws around it (the four
 * cards). It imports nothing from the code under test — not the shared `foldSearch`, not `parseSearchQuery`, not the SQL — so
 * when the endpoint and this agree on the same ids in the same order, that is two independently built implementations agreeing
 * (CLAUDE.md rules 7 / 8). The folding, date reading and word matching are the payment reference's (the legacy module 38 reuses
 * module 33's own helpers: `ERP.InvoiceSearch.util`).
 *
 * Differences from the legacy, all forced by running outside the browser (or by what a database cannot keep) and none by intent:
 *  - the Store `S` is a plain object of the backup's arrays;
 *  - `paidFor` skips the allocations of REVERSED payments: the legacy DELETED them on reversal, this database keeps them as
 *    history and excludes them (the reference is fed the legacy shape, so it skips them explicitly);
 *  - amounts arrive in paisa for `min` / `max`, periods arrive as `from` / `to` (the screen turns "this week" into dates);
 *  - ties the legacy left to array order (same date AND same entry time) fall to the invoice number, byte order, then the id —
 *    the reference states the number step; the datasets under test never tie on it further;
 *  - the paymentStatus word is DERIVED from the receipts (`Calc.paymentStatus` over `paidFor`), which is what the legacy's
 *    `refreshPaymentState` stored on the record after every payment; this database keeps no copy. (The committed fixture stores
 *    a stale "UNPAID" everywhere, so the reference must derive; a test over the real backup counts stored-vs-derived differences.)
 */
import { compact, hasTerm, joinN, dateText, parse, SEP } from "./legacy-payment-search.js";

type Doc = Record<string, any>;

export interface LegacyInvoiceStore {
  invoices: Doc[];
  invoiceItems: Doc[];
  payments: Doc[];
  paymentAllocations: Doc[];
  customerReturns: Doc[];
  customers: Doc[];
  regions: Doc[];
}

export interface InvoiceState {
  q?: string;
  scope?: string;
  status?: string;
  /** legacy region id */
  region?: string;
  /** legacy warehouse id */
  wh?: string;
  from?: string;
  to?: string;
  /** paisa */
  minP?: number;
  maxP?: number;
  sort?: string;
}

/** `ERP.STATUS_LABEL` (02-services.js). */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft", CONFIRMED: "Confirmed", DISPATCHED: "Dispatched", PARTIALLY_PAID: "Partly paid", PAID: "Paid", CANCELLED: "Cancelled",
  RETURNED: "Returned", PARTIALLY_RETURNED: "Partly returned", UNPAID: "Unpaid", PARTIAL: "Partly paid",
};
const SCOPE_FIELD: Record<string, string> = { number: "number", product: "product", amount: "amount", payment: "pay", notes: "other" };
const toR = (p: number) => Math.round(p || 0) / 100;

export function createLegacyInvoiceSearch(S: LegacyInvoiceStore) {
  const custById = new Map(S.customers.map((c) => [c.id, c]));
  const regById = new Map(S.regions.map((r) => [r.id, r]));
  const regionTxt = (id: string) => {
    const r = regById.get(id);
    return r ? r.ur + " " + r.en : "—";
  };
  const payById = new Map(S.payments.map((p) => [p.id, p]));

  /* ERP.Invoices.paidFor / outstanding */
  const paidFor = (invId: string) =>
    S.paymentAllocations.filter((a) => a.invoiceId === invId && payById.get(a.paymentId)?.status !== "REVERSED").reduce((a, x) => a + x.amount, 0);
  const outstanding = (inv: Doc) => {
    const credit = S.customerReturns.filter((r) => r.invoiceId === inv.id && r.status !== "CANCELLED").reduce((a, r) => a + r.creditAmount, 0);
    return inv.grandTotal - paidFor(inv.id) - credit;
  };

  /** `Calc.paymentStatus(grandTotal, paidFor)` — what `refreshPaymentState` keeps on the record. */
  const paymentStatusOf = (i: Doc): string => {
    const paid = paidFor(i.id);
    return i.grandTotal <= 0 ? "UNPAID" : paid >= i.grandTotal ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";
  };

  /* build(): one normalised text index per invoice */
  function build(): Record<string, any> {
    const out: Record<string, any> = {};
    const byInv: Record<string, Doc[]> = {};
    const payByInv: Record<string, Doc[]> = {};
    S.invoiceItems.forEach((it) => (byInv[it.invoiceId] = byInv[it.invoiceId] || []).push(it));
    S.paymentAllocations.forEach((a) => {
      const p = a.invoiceId && payById.get(a.paymentId);
      if (p && p.status !== "REVERSED") (payByInv[a.invoiceId] = payByInv[a.invoiceId] || []).push(p);
    });
    S.invoices.forEach((i) => {
      const items = (byInv[i.id] || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
      const lines = items.map((x) => ({
        n: joinN([[x.descriptionEnSnapshot, x.descriptionSnapshot, x.brandSnapshot].filter(Boolean).join(" ")]),
        name: x.descriptionEnSnapshot || x.descriptionSnapshot || "",
        qty: x.quantity,
      }));
      const total = toR(i.grandTotal);
      const withPaisa = total % 1 ? [total.toFixed(2), Number(total).toLocaleString("en-US", { minimumFractionDigits: 2 })] : [];
      const e: any = {
        number: joinN([i.invoiceNumber, compact(i.invoiceNumber), i.orderNumber, i.dispatchNumber, i.referenceNo]),
        customer: joinN([i.shopNameSnapshot, i.customerNameSnapshot, i.mobileSnapshot, compact(i.mobileSnapshot), i.regionSnapshot]),
        product: lines.map((l) => l.n).filter(Boolean).join(SEP),
        amount: joinN([String(total), Number(total).toLocaleString("en-US")].concat(withPaisa)),
        date: dateText(i.invoiceDate),
        pay: joinN((payByInv[i.id] || []).reduce((a: any[], p) => a.concat([p.receiptNumber, compact(p.receiptNumber), p.reference, compact(p.reference), p.method]), [])),
        payRef: joinN((payByInv[i.id] || []).reduce((a: any[], p) => a.concat([p.reference, compact(p.reference)]), [])),
        pays: (payByInv[i.id] || []).map((p) => ({
          no: p.receiptNumber, ref: p.reference || "", refText: joinN([p.reference, compact(p.reference)]),
          allText: joinN([p.receiptNumber, compact(p.receiptNumber), p.reference, compact(p.reference), p.method]),
        })),
        other: joinN([i.notes, i.description, i.salesperson, i.paymentMethod, i.warehouseSnapshot, STATUS_LABEL[i.status], STATUS_LABEL[paymentStatusOf(i)]]),
        items: lines,
      };
      e.all = [e.number, e.customer, e.product, e.amount, e.date, e.payRef, e.other].filter(Boolean).join(SEP);
      out[i.id] = e;
    });
    return out;
  }
  const idx = build();

  function currentCustomerText() {
    const memo: Record<string, string> = {};
    return (id: string) => {
      if (memo[id] !== undefined) return memo[id]!;
      const c = custById.get(id);
      let t = "";
      if (c) t = joinN([c.sh, c.ow, c.nameUr, c.ph, compact(c.ph), c.wa, c.legacyCode, regionTxt(c.region)]);
      return (memo[id] = t);
    };
  }

  function prepare(state: InvoiceState) {
    const p = parse(state.q);
    const scope = state.scope === "customer" || SCOPE_FIELD[state.scope ?? ""] ? state.scope! : "all";
    const problems: string[] = [];
    let ranges: any[] | null = null;
    if (p.dates.length) ranges = p.dates;
    else if (state.from || state.to) {
      if (state.from && state.to && state.from > state.to) problems.push("The “From” date is after the “To” date, so no invoice can match.");
      ranges = [{ from: state.from || null, to: state.to || null }];
    }
    const minP = state.minP ?? null;
    const maxP = state.maxP ?? null;
    if (minP !== null && maxP !== null && minP > maxP) problems.push("The minimum total is above the maximum, so no invoice can match.");
    return { p, scope, ranges, minP, maxP, problems };
  }

  function matcher(state: InvoiceState, ignoreStatus = false) {
    const pr = prepare(state);
    const terms = pr.p.terms;
    const cur = (pr.scope === "all" || pr.scope === "customer") && terms.length ? currentCustomerText() : null;
    return (inv: Doc) => {
      if (pr.problems.length) return false;
      if (!ignoreStatus && state.status && state.status !== "all" && inv.status !== state.status) return false;
      if (state.region && state.region !== "all" && inv.regionId !== state.region) return false;
      if (state.wh && state.wh !== "all" && inv.warehouseId !== state.wh) return false;
      if (pr.ranges) {
        const d = inv.invoiceDate;
        let ok = false;
        for (let k = 0; k < pr.ranges.length && !ok; k++) {
          const r = pr.ranges[k];
          ok = (!r.from || d >= r.from) && (!r.to || d <= r.to);
        }
        if (!ok) return false;
      }
      if (pr.minP !== null && inv.grandTotal < pr.minP) return false;
      if (pr.maxP !== null && inv.grandTotal > pr.maxP) return false;
      if (terms.length) {
        const e = idx[inv.id];
        if (!e) return false;
        const hays = pr.scope === "all" ? [e.all, cur!(inv.customerId)] : pr.scope === "customer" ? [e.customer, cur!(inv.customerId)] : [e[SCOPE_FIELD[pr.scope]!]];
        for (let j = 0; j < terms.length; j++) if (!hasTerm(hays, terms[j]!)) return false;
      }
      return true;
    };
  }

  function sortList(list: Doc[], key: string | undefined) {
    const due: Record<string, number> = {};
    const dueOf = (i: Doc) => (due[i.id] === undefined ? (due[i.id] = i.status === "CANCELLED" || i.status === "DRAFT" ? -1 : outstanding(i)) : due[i.id]!);
    const num = (i: Doc) => String(i.invoiceNumber || "");
    // > 0 when a is newer than b: date, entry time — then (the legacy left it to array order) the number in byte order
    function newer(a: Doc, b: Doc): number {
      if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
      const x = a.createdAt || "", y = b.createdAt || "";
      if (x !== y) return x < y ? -1 : 1;
      return num(a) === num(b) ? 0 : num(a) < num(b) ? -1 : 1;
    }
    const newestFirst = (a: Doc, b: Doc) => newer(b, a);
    let cmp: (a: Doc, b: Doc) => number;
    if (key === "oldest") cmp = newer;
    else if (key === "high") cmp = (a, b) => b.grandTotal - a.grandTotal || newestFirst(a, b);
    else if (key === "low") cmp = (a, b) => a.grandTotal - b.grandTotal || newestFirst(a, b);
    else if (key === "due") cmp = (a, b) => dueOf(b) - dueOf(a) || newestFirst(a, b);
    else cmp = newestFirst;
    return list.sort(cmp);
  }

  function hitsFor(state: InvoiceState) {
    const pr = prepare(state);
    const terms = pr.p.terms;
    const prod = pr.scope === "all" || pr.scope === "product";
    const pay = pr.scope === "all" || pr.scope === "payment";
    if (!terms.length || (!prod && !pay)) return () => null;
    const cur = currentCustomerText();
    return (inv: Doc) => {
      const e = idx[inv.id];
      if (!e) return null;
      let want = terms;
      if (pr.scope === "all") {
        const others = [e.number, e.customer, cur(inv.customerId)];
        want = terms.filter((t) => !hasTerm(others, t));
      }
      if (!want.length) return null;
      const hit = prod ? e.items.filter((x: any) => x.n && want.some((t) => hasTerm([x.n], t))) : [];
      const paid = pay
        ? e.pays.filter((x: any) => {
            const text = pr.scope === "all" ? x.refText : x.allText;
            return text && want.some((t) => hasTerm([text], t));
          })
        : [];
      if (!hit.length && !paid.length) return null;
      return {
        lines: hit.slice(0, 3).map((l: any) => ({ name: l.name, quantity: l.qty })),
        more: Math.max(0, hit.length - 3),
        pays: paid.slice(0, 3).map((x: any) => x.no + (x.ref ? " (" + x.ref + ")" : "")),
        morePays: Math.max(0, paid.length - 3),
      };
    };
  }

  return {
    /** the matches in order (legacy `results(state)`) */
    list(state: InvoiceState): Doc[] {
      return sortList(S.invoices.filter(matcher(state)), state.sort);
    },
    /** the four cards of `PAGES.invoices`: over the filtered list without drafts / cancelled; `drafts` counts every draft on file */
    kpis(state: InvoiceState) {
      const live = this.list(state).filter((i) => i.status !== "CANCELLED" && i.status !== "DRAFT");
      return {
        count: live.length,
        drafts: S.invoices.filter((i) => i.status === "DRAFT").length,
        invoicedP: live.reduce((a, i) => a + i.grandTotal, 0),
        receivedP: live.reduce((a, i) => a + paidFor(i.id), 0),
        outstandingP: live.reduce((a, i) => a + outstanding(i), 0),
      };
    },
    /** counts and totals per status under every filter except the status one */
    statusFacets(state: InvoiceState) {
      const out: Record<string, { count: number; totalP: number }> = {};
      for (const s of ["DRAFT", "CONFIRMED", "DISPATCHED", "PARTIALLY_PAID", "PAID", "CANCELLED", "RETURNED", "PARTIALLY_RETURNED"]) out[s] = { count: 0, totalP: 0 };
      for (const i of S.invoices.filter(matcher(state, true))) {
        const f = out[i.status];
        if (f) {
          f.count++;
          f.totalP += i.grandTotal;
        }
      }
      return out;
    },
    describe(state: InvoiceState) {
      const pr = prepare(state);
      return { terms: pr.p.terms, dates: pr.p.dates, problems: pr.problems };
    },
    hitsFor,
    paidFor,
    outstanding,
    paymentStatusOf,
    entry: (id: string) => idx[id],
  };
}
