import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { businessDateOf, formatPaisaPlain, INVOICE_STATUSES, type InvoiceListItem, type InvoiceListResponse } from "@farooq/shared";
import { RequireInvoicesAccess } from "../components/guard";
import { Badge, Banner, Button, EmptyState, ErrorLines, inputClass, LabeledSelect, useToast, cn } from "../components/ui";
import { useAuth } from "../lib/auth";
import { canCreateInvoice } from "../lib/access";
import { fmtDate } from "../lib/format";
import {
  buildInvoiceExportQuery,
  buildInvoicesQuery,
  hasActiveInvoiceFilters,
  hitsText,
  invoiceFiltersFromSearch,
  invoiceFiltersToSearch,
  PAGE_SIZE,
  SCOPE_OPTIONS,
  SORT_OPTIONS,
  statusLabel,
  statusTone,
  type InvoiceFilters,
} from "../lib/invoice-filters";
import { useMediaQuery } from "../lib/media";
import { describeReadDate } from "../lib/payment-filters";
import { PERIOD_OPTIONS } from "../lib/periods";
import { exportInvoicesCsv, getRegions, getWarehouses, keys, listInvoices } from "../lib/queries";

export function InvoicesPage() {
  return (
    <RequireInvoicesAccess>
      <InvoicesScreen />
    </RequireInvoicesAccess>
  );
}

function InvoicesScreen() {
  const filters = invoiceFiltersFromSearch(useSearch({ from: "/shell/invoices" }));
  const navigate = useNavigate();
  const toast = useToast();
  const today = businessDateOf(new Date());

  // the LATEST filters, not the ones of the render a timer was set in: a debounced q must not undo a filter changed while it waited
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });
  /** Any change of a filter goes back to page 1 (unless it IS the page) and is a `replace`, so Back leaves the screen, not the last keystroke. */
  const setFilters = (patch: Partial<InvoiceFilters>, opts: { replace?: boolean } = {}) => {
    const next = { ...latest.current, page: 1, ...patch };
    void navigate({ to: "/invoices", search: invoiceFiltersToSearch(next), replace: opts.replace ?? true });
  };

  // the search box: what is typed shows at once; the address (and so the request) follows 250 ms after the last key
  const [qInput, setQInput] = useState(filters.q);
  const lastSent = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== lastSent.current) {
      lastSent.current = filters.q;
      setQInput(filters.q); // changed from outside (Back, "Clear filters")
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

  const built = buildInvoicesQuery(filters, today);
  const hasInputErrors = Boolean(built.errors.min || built.errors.max);
  const list = useQuery({
    queryKey: keys.invoiceList(built.params),
    queryFn: ({ signal }) => listInvoices(built.params, signal),
    enabled: !hasInputErrors,
    placeholderData: keepPreviousData, // the table keeps its rows while the next answer loads
  });
  const regions = useQuery({ queryKey: keys.regions, queryFn: getRegions, staleTime: 5 * 60_000 });
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });

  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      const name = await exportInvoicesCsv(buildInvoiceExportQuery(filters, today).params);
      toast(`Downloaded ${name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "The export failed.", "error");
    } finally {
      setExporting(false);
    }
  }

  const data = list.data;
  const filtering = hasActiveInvoiceFilters(filters);
  const clearAll = () => {
    lastSent.current = "";
    setQInput("");
    void navigate({ to: "/invoices", search: {}, replace: true });
  };

  const { user } = useAuth();
  const mayCreate = user ? canCreateInvoice(user.role) : false;
  const wide = useMediaQuery("(min-width: 768px)");
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-(--color-text)">Invoices</h1>
          <p className="text-sm text-(--color-text-muted)">Sales invoices: find, read, print and correct them.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportCsv} disabled={exporting || hasInputErrors} aria-label="Export CSV">
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          {mayCreate ? (
            <Link to="/invoices/new" className="inline-flex items-center justify-center rounded-md bg-(--color-primary) px-3.5 py-2 text-sm font-medium text-(--color-primary-fg) hover:opacity-90" data-testid="new-invoice">
              New invoice
            </Link>
          ) : null}
        </div>
      </div>

      {data ? <KpiCards kpis={data.kpis} /> : null}

      {/* search */}
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
        <input
          type="search"
          aria-label="Search invoices"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Invoice no., shop, phone, product, amount, receipt, date…"
          title="Find an invoice by its number or order number, shop or phone, product, amount, receipt or reference, notes, or a date such as 12/09/2026"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          className={inputClass}
        />
        <select aria-label="Search in" value={filters.scope} onChange={(e) => setFilters({ scope: e.target.value })} className={cn(inputClass, "md:w-auto")}>
          {SCOPE_OPTIONS.map(([k, label]) => (
            <option key={k} value={k}>
              Search: {label}
            </option>
          ))}
        </select>
        <select aria-label="Sort by" value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value })} className={cn(inputClass, "md:w-auto")}>
          {SORT_OPTIONS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-end gap-2">
        <LabeledSelect label="Status" value={filters.status} onChange={(v) => setFilters({ status: v })}>
          <option value="">All statuses</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
              {data ? ` (${data.statusFacets[s].count})` : ""}
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
        <LabeledSelect label="Region" value={filters.region} onChange={(v) => setFilters({ region: v })}>
          <option value="">All regions</option>
          {(regions.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.nameEn}
            </option>
          ))}
        </LabeledSelect>
        <LabeledSelect label="Warehouse" value={filters.warehouse} onChange={(v) => setFilters({ warehouse: v })}>
          <option value="">All warehouses</option>
          {(warehouses.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </LabeledSelect>
        <label className="flex flex-col text-xs text-(--color-text-muted)">
          Total from
          <input
            inputMode="decimal"
            aria-label="Total from"
            value={filters.min}
            onChange={(e) => setFilters({ min: e.target.value })}
            placeholder="0"
            aria-invalid={built.errors.min ? true : undefined}
            className={cn(inputClass, "mt-0.5 w-28")}
          />
        </label>
        <label className="flex flex-col text-xs text-(--color-text-muted)">
          Total to
          <input
            inputMode="decimal"
            aria-label="Total to"
            value={filters.max}
            onChange={(e) => setFilters({ max: e.target.value })}
            placeholder="any"
            aria-invalid={built.errors.max ? true : undefined}
            className={cn(inputClass, "mt-0.5 w-28")}
          />
        </label>
        {filtering ? (
          <Button onClick={clearAll} aria-label="Clear filters">
            Clear filters
          </Button>
        ) : null}
      </div>
      {built.errors.min || built.errors.max ? (
        <Banner tone="warn" role="alert" data-testid="amount-problem">
          {built.errors.min ? <p>Total from: {built.errors.min}</p> : null}
          {built.errors.max ? <p>Total to: {built.errors.max}</p> : null}
        </Banner>
      ) : null}

      {/* how the box was read */}
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

      {/* the list */}
      {list.isError && !data ? (
        <ErrorLines error={list.error} onRetry={() => void list.refetch()} title="The invoices could not be loaded" />
      ) : !data && !hasInputErrors ? (
        <p role="status" className="py-10 text-center text-sm text-(--color-text-muted)">
          Loading invoices…
        </p>
      ) : data ? (
        <div className={cn("space-y-3", list.isFetching && "opacity-80")} aria-busy={list.isFetching}>
          {list.isError ? <ErrorLines error={list.error} onRetry={() => void list.refetch()} title="Could not refresh the list" /> : null}
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-(--color-text-muted)" data-testid="count-line">
            <span>
              {filtering ? (
                <>
                  <b className="text-(--color-text)">{data.total}</b> of {data.onFile} invoice{data.onFile === 1 ? "" : "s"} match
                </>
              ) : (
                <>
                  <b className="text-(--color-text)">{data.onFile}</b> invoice{data.onFile === 1 ? "" : "s"} on file
                </>
              )}
            </span>
            {list.isFetching ? <span role="status">Updating…</span> : null}
          </div>

          {data.items.length === 0 ? (
            data.onFile === 0 ? (
              <EmptyState title="No invoices yet">Sales invoices will be listed here.</EmptyState>
            ) : (
              <EmptyState title="No invoices match" action={filtering ? <Button onClick={clearAll}>Clear filters</Button> : null}>
                Nothing on file fits these words and filters. Try fewer words, widen the dates, or search in “Everything”.
              </EmptyState>
            )
          ) : (
            <>
              {wide ? <InvoicesTable items={data.items} /> : <InvoiceCards items={data.items} />}
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
      ) : null}
    </div>
  );
}

/** The four legacy cards, over the WHOLE filtered list (drafts and cancelled invoices left out) — as the server counted them. */
export function KpiCards({ kpis }: { kpis: InvoiceListResponse["kpis"] }) {
  const cards: { key: string; label: string; value: string; note?: string }[] = [
    { key: "count", label: "Invoices", value: String(kpis.count), note: `${kpis.drafts} draft${kpis.drafts === 1 ? "" : "s"} on file` },
    { key: "invoiced", label: "Invoiced", value: formatPaisaPlain(kpis.invoicedP) },
    { key: "received", label: "Received", value: formatPaisaPlain(kpis.receivedP) },
    { key: "outstanding", label: "Outstanding", value: formatPaisaPlain(kpis.outstandingP) },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="kpis">
      {cards.map((c) => (
        <div key={c.key} className="rounded-xl border border-(--color-border) bg-(--color-surface) px-3.5 py-2.5">
          <p className="text-xs text-(--color-text-muted)">{c.label}</p>
          <p className="num text-left text-lg font-bold text-(--color-text)" data-testid={`kpi-${c.key}`}>
            {c.value}
          </p>
          {c.note ? (
            <p className="text-xs text-(--color-text-muted)" data-testid={`kpi-${c.key}-note`}>
              {c.note}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function StatusPill({ item }: { item: Pick<InvoiceListItem, "status" | "paymentStatus"> }) {
  const pay = statusLabel(item.paymentStatus);
  // the payment word is only added where it says something the status does not ("Confirmed" + "Partly paid")
  const showPayment = !["DRAFT", "CANCELLED"].includes(item.status) && pay !== statusLabel(item.status);
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
      {showPayment ? <span className="text-[11px] text-(--color-text-muted)">{pay}</span> : null}
    </span>
  );
}

const numberText = (i: Pick<InvoiceListItem, "number">) => i.number ?? "Draft";

function NumberCell({ i }: { i: InvoiceListItem }) {
  const hits = hitsText(i.hits);
  return (
    <>
      <Link to="/invoices/$id" params={{ id: i.id }} className={cn("whitespace-nowrap font-mono text-xs text-(--color-primary) underline-offset-2 hover:underline", i.status === "CANCELLED" && "line-through")}>
        {numberText(i)}
      </Link>
      {i.orderNumber ? <span className="block whitespace-nowrap text-xs text-(--color-text-muted)">Order {i.orderNumber}</span> : null}
      {hits ? (
        <span dir="auto" className="mt-0.5 block max-w-[22rem] text-left text-xs text-(--color-text-muted)" data-testid="row-hits">
          {hits}
        </span>
      ) : null}
    </>
  );
}

function RowLinks({ i }: { i: InvoiceListItem }) {
  return (
    <>
      <Link to="/invoices/$id" params={{ id: i.id }} className="text-xs text-(--color-primary) hover:underline">
        Open
      </Link>
      <span aria-hidden className="mx-1.5 text-(--color-border)">
        |
      </span>
      <Link to="/invoices/$id/print" params={{ id: i.id }} className="text-xs text-(--color-primary) hover:underline">
        Print
      </Link>
      {i.customerId ? (
        <>
          <span aria-hidden className="mx-1.5 text-(--color-border)">
            |
          </span>
          <Link to="/statements" search={{ type: "customer", partyId: i.customerId }} className="text-xs text-(--color-primary) hover:underline">
            Statement
          </Link>
        </>
      ) : null}
    </>
  );
}

function InvoicesTable({ items }: { items: InvoiceListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-(--color-border) bg-(--color-surface)">
      <table className="w-full min-w-[76rem] text-sm">
        <thead className="bg-(--color-bg) text-left text-xs text-(--color-text-muted)">
          <tr>
            <th scope="col" className="sticky left-0 bg-(--color-bg) px-3 py-2 font-medium">Invoice no.</th>
            <th scope="col" className="px-3 py-2 font-medium">Date</th>
            <th scope="col" className="px-3 py-2 font-medium">Shop</th>
            <th scope="col" className="px-3 py-2 font-medium">Region</th>
            <th scope="col" className="num px-3 py-2 font-medium">Items</th>
            <th scope="col" className="px-3 py-2 font-medium">Warehouse</th>
            <th scope="col" className="num px-3 py-2 font-medium">Total</th>
            <th scope="col" className="num px-3 py-2 font-medium">Paid</th>
            <th scope="col" className="num px-3 py-2 font-medium">Balance</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const cancelled = i.status === "CANCELLED";
            return (
              <tr key={i.id} data-testid="invoice-row" data-number={i.number ?? ""} data-status={i.status} className="border-t border-(--color-border) align-top">
                <td className="sticky left-0 bg-(--color-surface) px-3 py-2">
                  <NumberCell i={i} />
                </td>
                <td className="whitespace-nowrap px-3 py-2">{fmtDate(i.date)}</td>
                <td className="min-w-[13rem] px-3 py-2">
                  <span dir="auto" className="block text-left font-medium text-(--color-text)">
                    {i.shopName}
                  </span>
                  {i.ownerName ? (
                    <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">
                      {i.ownerName}
                    </span>
                  ) : null}
                </td>
                <td dir="auto" className="whitespace-nowrap px-3 py-2 text-left">{i.region}</td>
                <td className="num px-3 py-2">{i.itemCount}</td>
                <td dir="auto" className="whitespace-nowrap px-3 py-2 text-left">{i.warehouse}</td>
                <td className={cn("num px-3 py-2 font-semibold", cancelled && "line-through opacity-70")}>{formatPaisaPlain(i.totalP)}</td>
                <td className="num px-3 py-2">{cancelled ? "" : formatPaisaPlain(i.paidP)}</td>
                <td className="num px-3 py-2">{cancelled || i.status === "DRAFT" ? "" : formatPaisaPlain(i.outstandingP)}</td>
                <td className="px-3 py-2">
                  <StatusPill item={i} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <RowLinks i={i} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The phone layout: one card per invoice — number, shop and the money first; nothing to scroll sideways to find. */
function InvoiceCards({ items }: { items: InvoiceListItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((i) => {
        const cancelled = i.status === "CANCELLED";
        return (
          <li key={i.id} data-testid="invoice-row" data-number={i.number ?? ""} data-status={i.status} className="rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
            <div className="flex items-start justify-between gap-3">
              <span dir="auto" className="min-w-0 text-left font-semibold text-(--color-text)">
                {i.shopName}
              </span>
              <span className={cn("num shrink-0 text-base font-bold", cancelled && "line-through opacity-70")}>{formatPaisaPlain(i.totalP)}</span>
            </div>
            {i.ownerName || i.region ? (
              <p dir="auto" className="text-left text-xs text-(--color-text-muted)">
                {[i.ownerName, i.region].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--color-text-muted)">
              <NumberCell i={i} />
              <span>{fmtDate(i.date)}</span>
              <StatusPill item={i} />
            </div>
            <p className="mt-1 text-xs text-(--color-text-muted)">
              {i.itemCount} item{i.itemCount === 1 ? "" : "s"}
              {i.warehouse ? ` · ${i.warehouse}` : ""}
              {!cancelled && i.status !== "DRAFT" ? (
                <>
                  {" "}
                  · Paid <span className="num">{formatPaisaPlain(i.paidP)}</span> · Balance <span className="num">{formatPaisaPlain(i.outstandingP)}</span>
                </>
              ) : null}
            </p>
            <div className="mt-2 flex gap-4 text-sm">
              <RowLinks i={i} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
