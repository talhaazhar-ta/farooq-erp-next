import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { businessDateOf, formatPaisaPlain, PURCHASE_LIST_LABELS as L, type PurchaseListItem, type PurchaseListResponse } from "@farooq/shared";
import { RequirePurchasesAccess } from "../components/guard";
import { Badge, Banner, Button, EmptyState, ErrorLines, inputClass, LabeledSelect, useToast, cn } from "../components/ui";
import { fmtDate } from "../lib/format";
import { useMediaQuery } from "../lib/media";
import { describeReadDate } from "../lib/payment-filters";
import { PERIOD_OPTIONS } from "../lib/periods";
import {
  bagsText,
  buildPurchasesQuery,
  hasActivePurchaseFilters,
  PAGE_SIZE,
  PAY_OPTIONS,
  payLabel,
  payTone,
  purchaseFiltersFromSearch,
  purchaseFiltersToSearch,
  purchaseHitsText,
  purchaseStatusLabel,
  SORT_OPTIONS,
  type PurchaseFilters,
} from "../lib/purchase-filters";
import { exportPurchasesCsv, getWarehouses, keys, listPurchases } from "../lib/queries";

export function PurchasesPage() {
  return (
    <RequirePurchasesAccess>
      <PurchasesScreen />
    </RequirePurchasesAccess>
  );
}

function PurchasesScreen() {
  const filters = purchaseFiltersFromSearch(useSearch({ from: "/shell/purchases" }));
  const navigate = useNavigate();
  const toast = useToast();
  const today = businessDateOf(new Date());

  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });
  const setFilters = (patch: Partial<PurchaseFilters>, opts: { replace?: boolean } = {}) => {
    const next = { ...latest.current, page: 1, ...patch };
    void navigate({ to: "/purchases", search: purchaseFiltersToSearch(next), replace: opts.replace ?? true });
  };

  // the search box: shown at once, sent 250 ms after the last key
  const [qInput, setQInput] = useState(filters.q);
  const lastSent = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== lastSent.current) {
      lastSent.current = filters.q;
      setQInput(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    if (qInput === filters.q) return;
    const t = setTimeout(() => {
      lastSent.current = qInput;
      setFilters({ q: qInput });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const params = buildPurchasesQuery(filters, today);
  const list = useQuery({ queryKey: keys.purchaseList(params), queryFn: ({ signal }) => listPurchases(params, signal), placeholderData: keepPreviousData });
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });

  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      toast(`Downloaded ${await exportPurchasesCsv(buildPurchasesQuery(filters, today, { paging: false }))}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "The export failed.", "error");
    } finally {
      setExporting(false);
    }
  }

  const data = list.data;
  const filtering = hasActivePurchaseFilters(filters);
  const clearAll = () => {
    lastSent.current = "";
    setQInput("");
    void navigate({ to: "/purchases", search: {}, replace: true });
  };
  const wide = useMediaQuery("(min-width: 768px)");
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-(--color-text)">Purchases</h1>
          <p className="text-sm text-(--color-text-muted)">
            {L.title} — {L.subtitle.charAt(0).toLowerCase() + L.subtitle.slice(1)}.
          </p>
        </div>
        <Button onClick={exportCsv} disabled={exporting} aria-label="Export CSV">
          {exporting ? "Exporting…" : "Export CSV"}
        </Button>
      </div>

      {data ? <PurchaseKpis kpis={data.kpis} /> : null}

      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        <input
          type="search"
          aria-label="Search purchases"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder={L.placeholder}
          title="Find a purchase by its number, the supplier (as printed or as now), the supplier's bill number, a product, the vehicle or driver, an amount, or a date such as 20/09/2026"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          className={inputClass}
        />
        <select aria-label="Sort by" value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value })} className={cn(inputClass, "md:w-auto")}>
          {SORT_OPTIONS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <LabeledSelect label="Payment" value={filters.pay} onChange={(v) => setFilters({ pay: v })}>
          <option value="">{L.allStatuses}</option>
          {PAY_OPTIONS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
              {data ? ` (${data.payFacets[k].count})` : ""}
            </option>
          ))}
        </LabeledSelect>
        <LabeledSelect label="Date" value={filters.period} onChange={(v) => setFilters({ period: v })}>
          {PERIOD_OPTIONS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </LabeledSelect>
        {filters.period === "custom" ? (
          <>
            <label className="flex flex-col text-xs text-(--color-text-muted)">
              From
              <input type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} className={cn(inputClass, "mt-0.5 w-auto")} />
            </label>
            <label className="flex flex-col text-xs text-(--color-text-muted)">
              To
              <input type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} className={cn(inputClass, "mt-0.5 w-auto")} />
            </label>
          </>
        ) : null}
        <LabeledSelect label="Warehouse" value={filters.warehouse} onChange={(v) => setFilters({ warehouse: v })}>
          <option value="">{L.allWarehouses}</option>
          {(warehouses.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </LabeledSelect>
        <LabeledSelect label="Category" value={filters.category} onChange={(v) => setFilters({ category: v })}>
          <option value="">{L.allCategories}</option>
          {(data?.categories ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </LabeledSelect>
        {filtering ? (
          <Button onClick={clearAll} aria-label="Clear filters">
            Clear filters
          </Button>
        ) : null}
      </div>

      {data?.interpreted.problems.map((m) => (
        <Banner key={m} tone="warn" role="alert" data-testid="search-problem">
          {m}
        </Banner>
      ))}
      {data?.interpreted.dates.map((d) => (
        <Banner key={d.src} tone="info" data-testid="search-read-as">
          {describeReadDate(d, data.interpreted.dateFilterReplaced)}
        </Banner>
      ))}

      {list.isError && !data ? (
        <ErrorLines error={list.error} onRetry={() => void list.refetch()} title="The purchases could not be loaded" />
      ) : !data ? (
        <p role="status" className="py-10 text-center text-sm text-(--color-text-muted)">
          Loading purchases…
        </p>
      ) : (
        <div className={cn("space-y-3", list.isFetching && "opacity-80")} aria-busy={list.isFetching}>
          {list.isError ? <ErrorLines error={list.error} onRetry={() => void list.refetch()} title="Could not refresh the list" /> : null}
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-(--color-text-muted)" data-testid="count-line">
            <span>
              {filtering ? (
                <>
                  <b className="text-(--color-text)">{data.total}</b> of {data.onFile} purchase{data.onFile === 1 ? "" : "s"} match
                </>
              ) : (
                <>
                  <b className="text-(--color-text)">{data.onFile}</b> purchase{data.onFile === 1 ? "" : "s"} on file
                </>
              )}
            </span>
            {list.isFetching ? <span role="status">Updating…</span> : null}
          </div>
          {data.items.length === 0 ? (
            data.onFile === 0 ? (
              <EmptyState title={L.empty}>{L.emptyHint}</EmptyState>
            ) : (
              <EmptyState title={L.noMatch} action={filtering ? <Button onClick={clearAll}>Clear filters</Button> : null}>
                {L.noMatchHint}
              </EmptyState>
            )
          ) : (
            <>
              {wide ? <PurchasesTable items={data.items} /> : <PurchaseCards items={data.items} />}
              {pages > 1 ? (
                <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-(--color-text-muted)" data-testid="page-range">
                    Showing {data.offset + 1}–{data.offset + data.items.length} of {data.total}
                  </span>
                  <span className="flex items-center gap-2">
                    <Button size="sm" disabled={filters.page <= 1} onClick={() => setFilters({ page: filters.page - 1 }, { replace: false })}>
                      Previous
                    </Button>
                    <span data-testid="page-number">
                      Page {filters.page} of {pages}
                    </span>
                    <Button size="sm" disabled={filters.page >= pages} onClick={() => setFilters({ page: filters.page + 1 }, { replace: false })}>
                      Next
                    </Button>
                  </span>
                </nav>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The legacy page's four cards, over the WHOLE filtered list (cancelled purchases left out) — as the server counted them. */
export function PurchaseKpis({ kpis }: { kpis: PurchaseListResponse["kpis"] }) {
  const cards: { key: string; label: string; value: string; note: string }[] = [
    {
      key: "bags",
      label: L.cardBags,
      value: bagsText(kpis.receivedQuantity),
      note: `${kpis.count} purchase${kpis.count === 1 ? "" : "s"}${kpis.orderedQuantity !== kpis.receivedQuantity ? ` · ${bagsText(kpis.orderedQuantity)} ordered` : ""}`,
    },
    { key: "value", label: L.cardValue, value: formatPaisaPlain(kpis.valueP), note: L.cardValueNote },
    { key: "owed", label: L.cardOwed, value: formatPaisaPlain(kpis.owedP), note: `unpaid on these bills · ${kpis.suppliersOwed} with a balance` },
    { key: "suppliers", label: L.cardSuppliers, value: String(kpis.suppliers), note: "on these purchases" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="kpis">
      {cards.map((c) => (
        <div key={c.key} className="rounded-xl border border-(--color-border) bg-(--color-surface) px-3.5 py-2.5">
          <p className="text-xs text-(--color-text-muted)">{c.label}</p>
          <p className="num text-left text-lg font-bold text-(--color-text)" data-testid={`kpi-${c.key}`}>
            {c.value}
          </p>
          <p className="text-xs text-(--color-text-muted)" data-testid={`kpi-${c.key}-note`}>
            {c.note}
          </p>
        </div>
      ))}
    </div>
  );
}

function StatusCell({ p }: { p: PurchaseListItem }) {
  const cancelled = p.status === "CANCELLED";
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {cancelled ? <Badge tone="danger">{purchaseStatusLabel(p.status)}</Badge> : <Badge tone={payTone(p.paymentStatus)}>{payLabel(p.paymentStatus)}</Badge>}
      {!cancelled && p.status !== "RECEIVED" ? <span className="text-[11px] text-(--color-text-muted)">{purchaseStatusLabel(p.status)}</span> : null}
    </span>
  );
}

function NumberCell({ p }: { p: PurchaseListItem }) {
  const hits = purchaseHitsText(p.hits);
  return (
    <>
      <Link to="/purchases/$id" params={{ id: p.id }} className={cn("whitespace-nowrap font-mono text-xs text-(--color-primary) underline-offset-2 hover:underline", p.status === "CANCELLED" && "line-through")}>
        {p.number ?? "No number"}
      </Link>
      {hits ? (
        <span dir="auto" className="mt-0.5 block max-w-[18rem] text-left text-xs text-(--color-text-muted)" data-testid="row-hits">
          {hits}
        </span>
      ) : null}
    </>
  );
}

function SupplierCell({ p }: { p: PurchaseListItem }) {
  return (
    <>
      <span dir="auto" className="block text-left font-medium text-(--color-text)">
        {p.supplierName ?? "—"}
      </span>
      {p.supplierCurrentName ? (
        <span dir="auto" className="block text-left text-xs text-(--color-text-muted)" data-testid="supplier-now">
          now {p.supplierCurrentName}
        </span>
      ) : null}
    </>
  );
}

function RowLinks({ p }: { p: PurchaseListItem }) {
  const sep = (
    <span aria-hidden className="mx-1.5 text-(--color-border)">
      |
    </span>
  );
  return (
    <>
      <Link to="/purchases/$id" params={{ id: p.id }} className="text-xs text-(--color-primary) hover:underline">
        Open
      </Link>
      {sep}
      <Link to="/purchases/$id/print" params={{ id: p.id }} className="text-xs text-(--color-primary) hover:underline">
        Print
      </Link>
      {p.supplierId ? (
        <>
          {sep}
          <Link to="/statements" search={{ type: "supplier", partyId: p.supplierId }} className="text-xs text-(--color-primary) hover:underline">
            Statement
          </Link>
        </>
      ) : null}
    </>
  );
}

/** "60 of 100" when a delivery was partial, else the bags. */
const bagsCell = (p: PurchaseListItem): string => (p.receivedQuantity === p.orderedQuantity ? bagsText(p.receivedQuantity) : `${bagsText(p.receivedQuantity)} of ${bagsText(p.orderedQuantity)}`);

function PurchasesTable({ items }: { items: PurchaseListItem[] }) {
  const [, supRef, sup, product, bagSize, warehouse, , rate, amount, payment, actions] = L.columns;
  return (
    <div className="overflow-x-auto rounded-xl border border-(--color-border) bg-(--color-surface)">
      <table className="w-full min-w-[78rem] text-sm">
        <thead className="bg-(--color-bg) text-left text-xs text-(--color-text-muted)">
          <tr>
            <th scope="col" className="sticky left-0 bg-(--color-bg) px-3 py-2 font-medium">Purchase no.</th>
            <th scope="col" className="px-3 py-2 font-medium">Date</th>
            <th scope="col" className="px-3 py-2 font-medium">{supRef}</th>
            <th scope="col" className="px-3 py-2 font-medium">{sup}</th>
            <th scope="col" className="px-3 py-2 font-medium">{product}</th>
            <th scope="col" className="px-3 py-2 font-medium">{bagSize}</th>
            <th scope="col" className="px-3 py-2 font-medium">{warehouse}</th>
            <th scope="col" className="num px-3 py-2 font-medium" title="Bags that arrived (of the bags ordered, on a part delivery)">Bags received</th>
            <th scope="col" className="num px-3 py-2 font-medium">{rate}</th>
            <th scope="col" className="num px-3 py-2 font-medium">{amount}</th>
            <th scope="col" className="num px-3 py-2 font-medium">Balance</th>
            <th scope="col" className="px-3 py-2 font-medium">{payment}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{actions}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const cancelled = p.status === "CANCELLED";
            return (
              <tr key={p.id} data-testid="purchase-row" data-number={p.number ?? ""} data-status={p.status} className="border-t border-(--color-border) align-top">
                <td className="sticky left-0 bg-(--color-surface) px-3 py-2">
                  <NumberCell p={p} />
                </td>
                <td className="whitespace-nowrap px-3 py-2">{fmtDate(p.date)}</td>
                <td dir="auto" className="whitespace-nowrap px-3 py-2 text-left font-mono text-xs">{p.supplierInvoiceNo ?? "—"}</td>
                <td className="min-w-[12rem] px-3 py-2">
                  <SupplierCell p={p} />
                </td>
                <td className="min-w-[11rem] px-3 py-2">
                  {p.firstLine ? (
                    <>
                      <span dir="auto" className="block text-left">{p.firstLine.name}</span>
                      {p.lineCount > 1 ? <span className="block text-xs text-(--color-text-muted)">+{p.lineCount - 1} more line{p.lineCount === 2 ? "" : "s"}</span> : null}
                    </>
                  ) : (
                    <span className="text-(--color-text-muted)">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{p.firstLine?.package ?? "—"}</td>
                <td dir="auto" className="whitespace-nowrap px-3 py-2 text-left">{p.warehouse ?? "—"}</td>
                <td className="num whitespace-nowrap px-3 py-2 font-semibold" data-testid="row-bags">{bagsCell(p)}</td>
                <td className="num px-3 py-2">{p.firstLine ? formatPaisaPlain(p.firstLine.unitPriceP) : "—"}</td>
                <td className={cn("num px-3 py-2 font-semibold", cancelled && "line-through opacity-70")}>{formatPaisaPlain(p.totalP)}</td>
                <td className="num px-3 py-2" data-testid="row-balance">{cancelled ? "" : formatPaisaPlain(p.balanceP)}</td>
                <td className="px-3 py-2">
                  <StatusCell p={p} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <RowLinks p={p} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PurchaseCards({ items }: { items: PurchaseListItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((p) => {
        const cancelled = p.status === "CANCELLED";
        return (
          <li key={p.id} data-testid="purchase-row" data-number={p.number ?? ""} data-status={p.status} className="rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SupplierCell p={p} />
              </div>
              <span className={cn("num shrink-0 text-base font-bold", cancelled && "line-through opacity-70")}>{formatPaisaPlain(p.totalP)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--color-text-muted)">
              <NumberCell p={p} />
              <span>{fmtDate(p.date)}</span>
              <StatusCell p={p} />
            </div>
            <p dir="auto" className="mt-1 text-left text-xs text-(--color-text-muted)">
              {p.firstLine ? `${p.firstLine.name}${p.lineCount > 1 ? ` +${p.lineCount - 1} more` : ""} · ` : ""}
              <span data-testid="row-bags">{bagsCell(p)}</span> bags{p.warehouse ? ` · ${p.warehouse}` : ""}
              {p.supplierInvoiceNo ? ` · ref ${p.supplierInvoiceNo}` : ""}
              {!cancelled ? (
                <>
                  {" "}
                  · Balance <span className="num">{formatPaisaPlain(p.balanceP)}</span>
                </>
              ) : null}
            </p>
            <div className="mt-2 flex gap-4 text-sm">
              <RowLinks p={p} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
