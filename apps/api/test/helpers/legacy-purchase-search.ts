/**
 * Two REFERENCE IMPLEMENTATIONS for the purchase list (S13), run over the legacy-shaped backup JSON. Neither imports anything from the
 * code under test (no shared `foldSearch` / `parseSearchQuery`, no SQL): the folding, date reading and word matching are the legacy
 * module 33 / 38 helpers already ported literally in `legacy-payment-search.ts`.
 *
 * 1. `legacyToolbar` — what the OLD Purchases page showed, literally (erp-upgrade/farooq-co-erp.html `PAGES.purchases` + `applyFilters`,
 *    02-services.js `Mirror` 1974-1987):
 *      row text  = pTxt(first line's product) + " " + the supplier's CURRENT company name + " " + the supplier's bill number
 *                  (pTxt = [ur, en, brandEn, cat, sku, id, kg, sourceFolio, normalizedName, nameEn], blanks dropped, joined by spaces);
 *      match     = the whole box, lower-cased and trimmed, is a substring of the lower-cased row text;
 *      filters   = data-status (Paid / Partial / Unpaid), data-wh (the HEADER godown), data-cat (the FIRST line's product `cat`), a date range.
 *    Forced differences: the payment word is derived from the allocations of POSTED vouchers (what the legacy stored after every
 *    payment; this database keeps no copy) and the date range arrives as from / to.
 *
 * 2. `purchaseReference` — the S13 rule (apps/api/src/purchases/purchases.search.ts) written a second time, independently: every folded
 *    word found in one of the documented fields; godown = header OR any line; category = any line's product; the typed date a filter;
 *    the sorts, the cards and the payment counts.
 */
import { compact, dateText, hasTerm, joinN, parse, SEP } from "./legacy-payment-search.js";

type Doc = Record<string, any>;

export interface LegacyPurchaseStore {
  purchases: Doc[];
  purchaseItems: Doc[];
  products: Doc[];
  suppliers: Doc[];
  payments: Doc[];
  paymentAllocations: Doc[];
}

export interface PurchaseState {
  q?: string;
  /** legacy warehouse id */
  wh?: string;
  /** a category (the legacy `cat` for the toolbar; `category ?? cat` for the reference) */
  cat?: string;
  pay?: "PAID" | "PARTIAL" | "UNPAID";
  from?: string;
  to?: string;
  sort?: "newest" | "oldest" | "high" | "low" | "due";
}

function common(S: LegacyPurchaseStore) {
  const prodById = new Map(S.products.map((p) => [p.id, p]));
  const supById = new Map(S.suppliers.map((s) => [s.id, s]));
  const payById = new Map(S.payments.map((p) => [p.id, p]));
  const items = (id: string) => S.purchaseItems.filter((i) => i.purchaseId === id).sort((a, b) => a.sortOrder - b.sortOrder);
  const paidFor = (id: string) =>
    S.paymentAllocations.filter((a) => a.purchaseId === id && payById.get(a.paymentId)?.status !== "REVERSED").reduce((a, x) => a + x.amount, 0);
  const payOf = (p: Doc): "PAID" | "PARTIAL" | "UNPAID" => {
    const paid = paidFor(p.id);
    return p.grandTotal <= 0 ? "UNPAID" : paid >= p.grandTotal ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";
  };
  return { prodById, supById, items, paidFor, payOf };
}

/* ── 1. the old page ─────────────────────────────────────────────────── */

export function legacyToolbar(S: LegacyPurchaseStore, state: PurchaseState): Set<string> {
  const { prodById, supById, items, payOf } = common(S);
  const pTxt = (p: Doc) => [p.ur, p.en, p.brandEn, p.cat, p.sku, p.id, p.kg, p.sourceFolio, p.normalizedName, p.nameEn].filter(Boolean).join(" ");
  const PAY: Record<string, string> = { PAID: "Paid", PARTIAL: "Partial", UNPAID: "Unpaid" };
  const q = String(state.q ?? "").toLowerCase().trim();
  const out = new Set<string>();
  for (const p of S.purchases) {
    const first = items(p.id)[0] || {};
    const pr = prodById.get(first.productId) || {};
    const sup = supById.get(p.supplierId);
    const row = `${pTxt(pr)} ${sup ? sup.co : ""} ${p.supplierInvoiceNo}`;
    const d = { row, status: PAY[payOf(p)], wh: p.warehouseId, cat: String(pr.cat), date: p.purchaseDate };
    const ok =
      (!q || d.row.toLowerCase().includes(q)) &&
      (!state.pay || !d.status || d.status === PAY[state.pay]) &&
      (!state.wh || !d.wh || d.wh === state.wh) &&
      (!state.cat || !d.cat || d.cat === state.cat) &&
      (!state.from || d.date >= state.from) &&
      (!state.to || d.date <= state.to);
    if (ok) out.add(p.id);
  }
  return out;
}

/* ── 2. the S13 rule ─────────────────────────────────────────────────── */

export interface ReferenceResult {
  ids: string[];
  problems: string[];
  kpis: { count: number; receivedQuantity: number; orderedQuantity: number; valueP: number; owedP: number; suppliers: number; suppliersOwed: number };
  payFacets: Record<"PAID" | "PARTIAL" | "UNPAID", { count: number; totalP: number }>;
  /** Per matching purchase: the names of the lines the words landed on that the header does not explain (the list's "why"). */
  hits: Map<string, string[]>;
}

export function purchaseReference(S: LegacyPurchaseStore, state: PurchaseState): ReferenceResult {
  const { prodById, supById, items, paidFor, payOf } = common(S);
  const categoryOf = (p: Doc | undefined) => (p ? p.category || p.cat || null : null);
  const productText = (p: Doc | undefined) =>
    p ? [joinN([p.ur, p.en, p.brandEn, categoryOf(p), p.cat, p.sku, p.id, p.kg]), joinN([p.sourceFolio, p.normalizedName, p.nameEn])].join(SEP) : "";
  const toR = (paisa: number) => paisa / 100;

  const idx = new Map<string, { own: string; lines: { name: string; n: string }[] }>();
  for (const p of S.purchases) {
    const total = toR(p.grandTotal);
    const withPaisa = total % 1 ? [total.toFixed(2), Number(total).toLocaleString("en-US", { minimumFractionDigits: 2 })] : [];
    const sup = supById.get(p.supplierId);
    const own = [
      joinN([p.purchaseNumber, compact(p.purchaseNumber), p.supplierInvoiceNo, compact(p.supplierInvoiceNo), p.deliveryRef]),
      joinN([p.supplierNameSnapshot]),
      joinN([String(total), Number(total).toLocaleString("en-US")].concat(withPaisa)),
      dateText(p.purchaseDate),
      joinN([p.vehicleNo, compact(p.vehicleNo), p.driver, p.warehouseSnapshot, p.notes, p.description]),
      sup ? joinN([sup.co, sup.cp, sup.ph, compact(sup.ph), sup.lo]) : "",
    ].join(SEP);
    const lines = items(p.id).map((it) => ({
      name: it.descriptionEnSnapshot || it.descriptionSnapshot || "",
      n: [joinN([it.descriptionEnSnapshot, it.descriptionSnapshot, it.brandSnapshot, it.packageSnapshot]), productText(prodById.get(it.productId))].join(SEP),
    }));
    idx.set(p.id, { own, lines });
  }

  const parsed = parse(state.q);
  const problems: string[] = [];
  let ranges: { from: string | null; to: string | null }[] | null = null;
  if (parsed.dates.length) ranges = parsed.dates.map((d: any) => ({ from: d.from, to: d.to }));
  else if (state.from || state.to) {
    if (state.from && state.to && state.from > state.to) problems.push("The “From” date is after the “To” date, so no purchase can match.");
    ranges = [{ from: state.from ?? null, to: state.to ?? null }];
  }
  const empty = (): ReferenceResult => ({
    ids: [],
    problems,
    kpis: { count: 0, receivedQuantity: 0, orderedQuantity: 0, valueP: 0, owedP: 0, suppliers: 0, suppliersOwed: 0 },
    payFacets: { PAID: { count: 0, totalP: 0 }, UNPAID: { count: 0, totalP: 0 }, PARTIAL: { count: 0, totalP: 0 } },
    hits: new Map(),
  });
  if (problems.length) return empty();

  const terms = parsed.terms;
  const beforePay = S.purchases.filter((p) => {
    const its = items(p.id);
    if (state.wh && p.warehouseId !== state.wh && !its.some((i) => i.warehouseId === state.wh)) return false;
    if (state.cat && !its.some((i) => categoryOf(prodById.get(i.productId)) === state.cat)) return false;
    if (ranges && !ranges.some((r) => (!r.from || p.purchaseDate >= r.from) && (!r.to || p.purchaseDate <= r.to))) return false;
    const e = idx.get(p.id)!;
    return terms.every((t) => hasTerm([e.own], t) || e.lines.some((l) => hasTerm([l.n], t)));
  });
  const res = empty();
  for (const p of beforePay) {
    const k = payOf(p);
    res.payFacets[k].count++;
    res.payFacets[k].totalP += p.grandTotal;
  }
  const matched = beforePay.filter((p) => !state.pay || payOf(p) === state.pay);

  const byte = (a: string | null | undefined, b: string | null | undefined) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1);
  const newer = (a: Doc, b: Doc) => byte(b.purchaseDate, a.purchaseDate) || byte(b.createdAt, a.createdAt) || byte(b.purchaseNumber ?? null, a.purchaseNumber ?? null);
  const due = (p: Doc) => (p.status === "CANCELLED" ? -1 : p.grandTotal - paidFor(p.id));
  const cmp: Record<string, (a: Doc, b: Doc) => number> = {
    newest: newer,
    oldest: (a, b) => byte(a.purchaseDate, b.purchaseDate) || byte(a.createdAt, b.createdAt) || -byte(b.purchaseNumber ?? null, a.purchaseNumber ?? null),
    high: (a, b) => b.grandTotal - a.grandTotal || newer(a, b),
    low: (a, b) => a.grandTotal - b.grandTotal || newer(a, b),
    due: (a, b) => due(b) - due(a) || newer(a, b),
  };
  res.ids = matched.slice().sort(cmp[state.sort ?? "newest"]).map((p) => p.id);

  const live = matched.filter((p) => p.status !== "CANCELLED");
  const owedBySup = new Map<string, number>();
  let rcv = 0;
  let ord = 0;
  for (const p of live) {
    res.kpis.count++;
    // the header's own totals (the importer keeps them; a header-only purchase has no lines to add up)
    rcv += Math.round((p.receivedQty ?? 0) * 1000);
    ord += Math.round((p.orderedQty ?? 0) * 1000);
    res.kpis.valueP += p.grandTotal;
    const owed = p.grandTotal - paidFor(p.id);
    res.kpis.owedP += owed;
    if (p.supplierId) owedBySup.set(p.supplierId, (owedBySup.get(p.supplierId) ?? 0) + owed);
  }
  res.kpis.receivedQuantity = rcv / 1000;
  res.kpis.orderedQuantity = ord / 1000;
  res.kpis.suppliers = owedBySup.size;
  res.kpis.suppliersOwed = [...owedBySup.values()].filter((v) => v > 0).length;

  for (const p of matched) {
    const e = idx.get(p.id)!;
    const want = terms.filter((t) => !hasTerm([e.own], t));
    if (!want.length) continue;
    const hit = e.lines.filter((l) => want.some((t) => hasTerm([l.n], t)));
    if (hit.length) res.hits.set(p.id, hit.map((l) => l.name));
  }
  return res;
}
