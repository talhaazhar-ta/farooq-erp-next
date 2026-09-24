import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { businessDateOf, formatPaisaPlain, type PaymentListItem } from "@farooq/shared";
import { RequirePaymentsAccess } from "../components/guard";
import { PaymentPanel } from "../components/payment-panels";
import { Badge, Banner, Button, EmptyState, ErrorLines, inputClass, LabeledSelect, useToast, cn } from "../components/ui";
import { useMediaQuery } from "../lib/media";
import { useAuth } from "../lib/auth";
import { canPayOut, canReceive } from "../lib/access";
import { fmtDate, KIND_LABELS } from "../lib/format";
import { PERIOD_OPTIONS } from "../lib/periods";
import {
  buildExportQuery,
  buildPaymentsQuery,
  describeReadDate,
  filtersFromSearch,
  filtersToSearch,
  hasActiveFilters,
  PAGE_SIZE,
  PAYMENT_METHODS,
  SCOPE_OPTIONS,
  SORT_OPTIONS,
  type PaymentFilters,
  type PaymentTab,
} from "../lib/payment-filters";
import { exportPaymentsCsv, getRegions, keys, listPayments } from "../lib/queries";

export function PaymentsPage() {
  return (
    <RequirePaymentsAccess>
      <PaymentsScreen />
    </RequirePaymentsAccess>
  );
}

function PaymentsScreen() {
  const { user } = useAuth();
  const filters = filtersFromSearch(useSearch({ from: "/shell/payments" }));
  const navigate = useNavigate();
  const toast = useToast();
  const today = businessDateOf(new Date());

  /** Any change of a filter goes back to page 1 (unless it IS the page) and is a `replace`, so Back leaves the screen, not the last keystroke. */
  // the LATEST filters, not the ones of the render a timer was set in: a debounced q must not undo a filter changed while it waited
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });
  const setFilters = (patch: Partial<PaymentFilters>, opts: { replace?: boolean } = {}) => {
    const next = { ...latest.current, page: 1, ...patch };
    void navigate({ to: "/payments", search: filtersToSearch(next), replace: opts.replace ?? true });
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

  const built = buildPaymentsQuery(filters, today);
  const hasInputErrors = Boolean(built.errors.min || built.errors.max);
  const list = useQuery({
    queryKey: keys.paymentList(built.params),
    queryFn: ({ signal }) => listPayments(built.params, signal),
    enabled: !hasInputErrors,
    placeholderData: keepPreviousData, // the table keeps its rows while the next answer loads
  });
  const regions = useQuery({ queryKey: keys.regions, queryFn: getRegions, staleTime: 5 * 60_000 });

  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      const name = await exportPaymentsCsv(buildExportQuery(filters, today).params);
      toast(`Downloaded ${name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "The export failed.", "error");
    } finally {
      setExporting(false);
    }
  }

  const data = list.data;
  const filtering = hasActiveFilters(filters);
  const clearAll = () => {
    lastSent.current = "";
    setQInput("");
    void navigate({ to: "/payments", search: {}, replace: true });
  };

  const facets = data?.facets;
  const tabDefs: { key: PaymentTab; label: string; count: number | null; totalP: number | null }[] = [
    {
      key: "all",
      label: "All payments",
      count: facets ? facets.received.count + facets.paidToShops.count + facets.paidToSuppliers.count : null,
      totalP: null,
    },
    { key: "received", label: "Received from shops", count: facets?.received.count ?? null, totalP: facets?.received.totalP ?? null },
    { key: "paidToShops", label: "Paid to shops", count: facets?.paidToShops.count ?? null, totalP: facets?.paidToShops.totalP ?? null },
    { key: "paidToSuppliers", label: "Paid to suppliers", count: facets?.paidToSuppliers.count ?? null, totalP: facets?.paidToSuppliers.totalP ?? null },
    { key: "reversed", label: "Reversed", count: facets?.reversed.count ?? null, totalP: facets?.reversed.totalP ?? null },
  ];
  const activeTab = tabDefs.find((t) => t.key === filters.tab)!;

  const wide = useMediaQuery("(min-width: 768px)");
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-(--color-text)">Payments</h1>
          <p className="text-sm text-(--color-text-muted)">Money received from shops and paid out to shops and suppliers.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {user && canReceive(user.role) ? (
            <Button variant="primary" onClick={() => setFilters({ panel: "receive" }, { replace: false })}>
              Receive payment
            </Button>
          ) : null}
          {user && canPayOut(user.role) ? (
            <>
              <Button onClick={() => setFilters({ panel: "pay" }, { replace: false })}>Pay supplier</Button>
              <Button onClick={() => setFilters({ panel: "refund" }, { replace: false })}>Pay a shop</Button>
            </>
          ) : null}
          <Button onClick={exportCsv} disabled={exporting || hasInputErrors} aria-label="Export CSV">
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* search */}
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
        <input
          type="search"
          aria-label="Search payments"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Receipt no., shop, phone, reference, amount, date…"
          title="Find a payment by receipt or voucher number, shop or supplier, phone, cheque / transaction reference, amount, a date such as 12/09/2026, or the invoice it was applied to"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          className={inputClass}
        />
        <select aria-label="Search in" value={filters.scope} onChange={(e) => setFilters({ scope: e.target.value })} className={cn(inputClass, "md:w-auto")}>
          {SCOPE_OPTIONS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
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

      {/* tabs */}
      <div role="tablist" aria-label="Kind of payment" className="flex gap-1 overflow-x-auto border-b border-(--color-border)">
        {tabDefs.map((t) => {
          const selected = filters.tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={selected}
              data-testid={`tab-${t.key}`}
              onClick={() => setFilters({ tab: t.key })}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm",
                selected ? "border-(--color-primary) font-semibold text-(--color-text)" : "border-transparent text-(--color-text-muted) hover:text-(--color-text)",
              )}
            >
              {t.label}
              {t.count !== null ? <span className="ml-1.5 rounded-full bg-(--color-bg) px-1.5 py-0.5 text-xs" data-testid={`tab-count-${t.key}`}>{t.count}</span> : null}
            </button>
          );
        })}
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-end gap-2">
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
        <LabeledSelect label="Method" value={filters.method} onChange={(v) => setFilters({ method: v })}>
          <option value="">All methods</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </LabeledSelect>
        <LabeledSelect label="Region" value={filters.region} onChange={(v) => setFilters({ region: v })}>
          <option value="">All regions</option>
          {(regions.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.nameEn}
            </option>
          ))}
        </LabeledSelect>
        <label className="flex flex-col text-xs text-(--color-text-muted)">
          Amount from
          <input
            inputMode="decimal"
            aria-label="Amount from"
            value={filters.min}
            onChange={(e) => setFilters({ min: e.target.value })}
            placeholder="0"
            aria-invalid={built.errors.min ? true : undefined}
            className={cn(inputClass, "mt-0.5 w-28")}
          />
        </label>
        <label className="flex flex-col text-xs text-(--color-text-muted)">
          Amount to
          <input
            inputMode="decimal"
            aria-label="Amount to"
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
          {built.errors.min ? <p>Amount from: {built.errors.min}</p> : null}
          {built.errors.max ? <p>Amount to: {built.errors.max}</p> : null}
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
      {filters.region && data ? (
        <Banner tone="info">A region belongs to a shop, so payments to suppliers are left out while one is chosen.</Banner>
      ) : null}

      {/* the list */}
      {list.isError && !data ? (
        <ErrorLines error={list.error} onRetry={() => void list.refetch()} title="The payments could not be loaded" />
      ) : !data && !hasInputErrors ? (
        <p role="status" className="py-10 text-center text-sm text-(--color-text-muted)">
          Loading payments…
        </p>
      ) : data ? (
        <div className={cn("space-y-3", list.isFetching && "opacity-80")} aria-busy={list.isFetching}>
          {list.isError ? <ErrorLines error={list.error} onRetry={() => void list.refetch()} title="Could not refresh the list" /> : null}
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-(--color-text-muted)" data-testid="count-line">
            <span>
              {filtering ? (
                <>
                  <b className="text-(--color-text)">{data.total}</b> of {data.onFile} payment{data.onFile === 1 ? "" : "s"} match
                </>
              ) : (
                <>
                  <b className="text-(--color-text)">{data.onFile}</b> payment{data.onFile === 1 ? "" : "s"} on file
                </>
              )}
              {activeTab.totalP !== null ? (
                <span className="ml-2">
                  · total <b className="num text-(--color-text)">{formatPaisaPlain(activeTab.totalP)}</b>
                </span>
              ) : null}
            </span>
            {list.isFetching ? <span role="status">Updating…</span> : null}
          </div>

          {data.items.length === 0 ? (
            data.onFile === 0 ? (
              <EmptyState title="No payments yet">Money received from shops and paid out will be listed here.</EmptyState>
            ) : (
              <EmptyState
                title="No payments match"
                action={
                  filtering ? (
                    <Button onClick={clearAll}>Clear filters</Button>
                  ) : null
                }
              >
                Nothing on file fits these words and filters. Try fewer words, widen the dates, or search in “Everything”.
              </EmptyState>
            )
          ) : (
            <>
              {wide ? <PaymentsTable items={data.items} /> : <PaymentCards items={data.items} />}
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

      {filters.panel === "receive" && user && canReceive(user.role) ? <PaymentPanel mode="receive" onClose={() => setFilters({ panel: "" }, { replace: false })} /> : null}
      {filters.panel === "pay" && user && canPayOut(user.role) ? <PaymentPanel mode="pay" onClose={() => setFilters({ panel: "" }, { replace: false })} /> : null}
      {filters.panel === "refund" && user && canPayOut(user.role) ? <PaymentPanel mode="refund" onClose={() => setFilters({ panel: "" }, { replace: false })} /> : null}
    </div>
  );
}

function appliedSummary(p: PaymentListItem): string {
  if (p.appliedTo.length === 0) return p.kind === "received" ? "On account" : "—";
  const shown = p.appliedTo.slice(0, 3).join(", ");
  const more = p.appliedTo.length > 3 ? ` +${p.appliedTo.length - 3}` : "";
  return `${shown}${more}${p.unallocatedP > 0 ? " · rest on account" : ""}`;
}

function PaymentsTable({ items }: { items: PaymentListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-(--color-border) bg-(--color-surface)">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="bg-(--color-bg) text-left text-xs text-(--color-text-muted)">
          <tr>
            <th scope="col" className="sticky left-0 bg-(--color-bg) px-3 py-2 font-medium">Receipt no.</th>
            <th scope="col" className="px-3 py-2 font-medium">Date</th>
            <th scope="col" className="px-3 py-2 font-medium">Shop / supplier</th>
            <th scope="col" className="px-3 py-2 font-medium">Type</th>
            <th scope="col" className="px-3 py-2 font-medium">Method</th>
            <th scope="col" className="px-3 py-2 font-medium">Reference</th>
            <th scope="col" className="num px-3 py-2 font-medium">Amount</th>
            <th scope="col" className="px-3 py-2 font-medium">Applied to</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Open</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const reversed = p.status === "REVERSED";
            const name = p.partyNameSnapshot ?? p.partyName ?? "";
            const renamed = p.partyName && p.partyNameSnapshot && p.partyName !== p.partyNameSnapshot;
            return (
              <tr key={p.id} data-testid="payment-row" data-number={p.receiptNumber} className="border-t border-(--color-border) align-top">
                <td className={cn("sticky left-0 whitespace-nowrap bg-(--color-surface) px-3 py-2 font-mono text-xs", reversed && "line-through opacity-70")}>
                  <Link to="/payments/$id" params={{ id: p.id }} className="text-(--color-primary) underline-offset-2 hover:underline">
                    {p.receiptNumber}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2">{fmtDate(p.paymentDate)}</td>
                <td className="px-3 py-2">
                  <span dir="auto" className="font-medium text-(--color-text)">
                    {name}
                  </span>
                  {renamed ? (
                    <span dir="auto" className="block text-xs text-(--color-text-muted)">
                      now: {p.partyName}
                    </span>
                  ) : null}
                  {p.regionName ? (
                    <span dir="auto" className="block text-xs text-(--color-text-muted)">
                      {p.regionName}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {KIND_LABELS[p.kind]}
                  {reversed ? (
                    <span className="ml-1.5">
                      <Badge tone="danger">Reversed</Badge>
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2">{p.method}</td>
                <td className="px-3 py-2 font-mono text-xs" dir="auto">{p.reference}</td>
                <td className={cn("num whitespace-nowrap px-3 py-2 font-semibold", reversed && "line-through opacity-70")}>{formatPaisaPlain(p.amountP)}</td>
                <td className="px-3 py-2 text-xs text-(--color-text-muted)">{appliedSummary(p)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Link to="/payments/$id" params={{ id: p.id }} className="text-xs text-(--color-primary) hover:underline">
                    Open
                  </Link>
                  <span aria-hidden className="mx-1.5 text-(--color-border)">|</span>
                  <Link to="/payments/$id/receipt" params={{ id: p.id }} className="text-xs text-(--color-primary) hover:underline">
                    {p.direction === "IN" ? "Receipt" : "Voucher"}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The phone layout: one card per payment, the amount and the party first — nothing to scroll sideways to find. */
function PaymentCards({ items }: { items: PaymentListItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((p) => {
        const reversed = p.status === "REVERSED";
        const name = p.partyNameSnapshot ?? p.partyName ?? "";
        return (
          <li key={p.id} data-testid="payment-row" data-number={p.receiptNumber} className="rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
            <div className="flex items-start justify-between gap-3">
              <span dir="auto" className="min-w-0 font-semibold text-(--color-text)">{name}</span>
              <span className={cn("num shrink-0 text-base font-bold", reversed && "line-through opacity-70")}>{formatPaisaPlain(p.amountP)}</span>
            </div>
            {p.regionName ? <p dir="auto" className="text-xs text-(--color-text-muted)">{p.regionName}</p> : null}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--color-text-muted)">
              <span className={cn("font-mono", reversed && "line-through")}>{p.receiptNumber}</span>
              <span>{fmtDate(p.paymentDate)}</span>
              <span>{KIND_LABELS[p.kind]}</span>
              {p.method ? <span>{p.method}</span> : null}
              {reversed ? <Badge tone="danger">Reversed</Badge> : null}
            </p>
            {p.reference ? <p dir="auto" className="mt-1 font-mono text-xs text-(--color-text-muted)">Ref {p.reference}</p> : null}
            <p className="mt-1 text-xs text-(--color-text-muted)">Applied to: {appliedSummary(p)}</p>
            <div className="mt-2 flex gap-4 text-sm">
              <Link to="/payments/$id" params={{ id: p.id }} className="text-(--color-primary) hover:underline">Open</Link>
              <Link to="/payments/$id/receipt" params={{ id: p.id }} className="text-(--color-primary) hover:underline">{p.direction === "IN" ? "Receipt" : "Voucher"}</Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
