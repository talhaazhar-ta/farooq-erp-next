import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { businessDateOf, formatPaisaPlain, rupeesText, type PartyLookupItem, type Statement } from "@farooq/shared";
import { RequirePaymentsAccess } from "../components/guard";
import { PartyCombobox } from "../components/party-combobox";
import { Banner, Button, EmptyState, ErrorLines, inputClass, cn } from "../components/ui";
import { balanceCell, balanceWords, fmtDate, type PartyKind } from "../lib/format";
import { PERIOD_OPTIONS } from "../lib/periods";
import { getCompany, getRegions, getStatement, keys } from "../lib/queries";
import { statementSearchFrom, statementSearchOut, statementWindow, type StatementFilters } from "../lib/statement-filters";
import { ApiError } from "../lib/api";

export function StatementsPage() {
  return (
    <RequirePaymentsAccess>
      <StatementsScreen />
    </RequirePaymentsAccess>
  );
}

function StatementsScreen() {
  const f: StatementFilters = statementSearchFrom(useSearch({ from: "/shell/statements" }));
  const navigate = useNavigate();
  const today = businessDateOf(new Date());
  const window_ = statementWindow(f, today);
  const set = (patch: Partial<StatementFilters>) => void navigate({ to: "/statements", search: statementSearchOut({ ...f, ...patch }), replace: true });

  // From after To can never match: say so (below) and do not ask the server
  const badRange = f.period === "custom" && Boolean(f.from) && Boolean(f.to) && f.from > f.to;

  const regions = useQuery({ queryKey: keys.regions, queryFn: getRegions, staleTime: 5 * 60_000, enabled: f.type === "customer" });
  const statement = useQuery({
    queryKey: keys.statement(f.type, f.partyId, window_.from, window_.to),
    queryFn: ({ signal }) => getStatement(f.type, f.partyId, window_.from, window_.to, signal),
    enabled: Boolean(f.partyId) && !badRange,
    placeholderData: keepPreviousData,
  });
  const company = useQuery({ queryKey: keys.company, queryFn: getCompany, staleTime: 10 * 60_000 });

  const data = statement.data && statement.data.party.id === f.partyId ? statement.data : undefined;
  // the chosen party as the picker shows it: named by the statement once it has loaded (a "View statement" link carries only the id)
  const chosen: PartyLookupItem | null = useMemo(
    () => (f.partyId && data ? { id: f.partyId, name: data.party.name, contact: data.party.owner, phone: data.party.phone, region: data.party.region, regionId: null, active: true } : null),
    [f.partyId, data],
  );

  return (
    <div className="space-y-4">
      <div className="no-print space-y-4 print:hidden">
        <div>
          <h1 className="text-lg font-semibold text-(--color-text)">Account statements</h1>
          <p className="text-sm text-(--color-text-muted)">What a shop or supplier has been charged and has paid, built from the ledger.</p>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
          <div role="radiogroup" aria-label="Statement for" className="inline-flex overflow-hidden rounded-md border border-(--color-border) text-sm">
            {(
              [
                ["customer", "Shops"],
                ["supplier", "Suppliers"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={cn("cursor-pointer px-3 py-2", f.type === value ? "bg-(--color-primary) text-(--color-primary-fg)" : "bg-(--color-surface) text-(--color-text)")}>
                <input type="radio" name="party-type" value={value} checked={f.type === value} onChange={() => set({ type: value, partyId: "", region: "" })} className="sr-only" />
                {label}
              </label>
            ))}
          </div>

          {f.type === "customer" ? (
            <label className="text-xs text-(--color-text-muted)">
              Area
              <select
                aria-label="Area"
                value={f.region}
                onChange={(e) => set({ region: e.target.value, partyId: "" })}
                className={cn(inputClass, "mt-0.5 w-auto")}
              >
                <option value="">All areas</option>
                {(regions.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nameEn}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="min-w-[14rem] flex-1 text-xs text-(--color-text-muted)">
            <span className="mb-0.5 block">{f.type === "customer" ? "Shop" : "Supplier"}</span>
            <PartyCombobox
              key={f.type}
              type={f.type}
              value={chosen}
              regionId={f.type === "customer" ? f.region : ""}
              label={f.type === "customer" ? "Shop" : "Supplier"}
              onChange={(p) => set({ partyId: p?.id ?? "" })}
            />
          </div>

          <label className="text-xs text-(--color-text-muted)">
            Date
            <select aria-label="Date" value={f.period} onChange={(e) => set({ period: e.target.value })} className={cn(inputClass, "mt-0.5 w-auto")}>
              {PERIOD_OPTIONS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {f.period === "custom" ? (
            <>
              <label className="text-xs text-(--color-text-muted)">
                From
                <input type="date" aria-label="From" value={f.from} onChange={(e) => set({ from: e.target.value })} className={cn(inputClass, "mt-0.5 w-auto")} />
              </label>
              <label className="text-xs text-(--color-text-muted)">
                To
                <input type="date" aria-label="To" value={f.to} onChange={(e) => set({ to: e.target.value })} className={cn(inputClass, "mt-0.5 w-auto")} />
              </label>
            </>
          ) : null}
          <Button onClick={() => void navigate({ to: "/statements", search: { type: f.type }, replace: true })}>Clear</Button>
        </div>
        {badRange ? (
          <Banner tone="warn" role="alert">
            The “From” date is after the “To” date, so no statement can be shown.
          </Banner>
        ) : null}
      </div>

      {badRange ? null : !f.partyId ? (
        <EmptyState title={`Choose a ${f.type === "customer" ? "shop" : "supplier"} to see its statement`}>Pick a name above. Nothing is shown until you do.</EmptyState>
      ) : statement.isError ? (
        <ErrorLines
          error={statement.error}
          onRetry={() => void statement.refetch()}
          title={statement.error instanceof ApiError && statement.error.status === 404 ? "That party was not found" : "The statement could not be loaded"}
        />
      ) : !data ? (
        <p role="status" className="py-10 text-center text-sm text-(--color-text-muted)">
          Loading statement…
        </p>
      ) : (
        <StatementPaper s={data} kind={f.type === "customer" ? "CUSTOMER" : "SUPPLIER"} company={company.data?.businessName ?? null} />
      )}
    </div>
  );
}

/** A statement as a sheet of paper: the same on screen and in print. */
function StatementPaper({ s, kind, company }: { s: Statement; kind: PartyKind; company: string | null }) {
  const period = s.from || s.to ? `${s.from ? fmtDate(s.from) : "the beginning"} to ${s.to ? fmtDate(s.to) : "today"}` : "All dates";

  function downloadCsv() {
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    // a cell that starts like a formula is neutralised (spreadsheet injection), same as the payments export
    const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const lines = [
      ["Date", "Ref", "Description", "Qty", "Debit", "Credit", "Balance"].map(q).join(","),
      ...s.rows.map((r) => [r.date, r.ref, r.detail ?? r.description, r.qtyLabel, rupeesText(r.debitP), rupeesText(r.creditP), rupeesText(r.balanceP)].map((c) => q(safe(c))).join(",")),
    ];
    const blob = new Blob([String.fromCharCode(0xfeff) + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `statement-${s.party.name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <div className="space-y-3">
      <div className="no-print flex flex-wrap justify-end gap-2 print:hidden">
        <Button onClick={downloadCsv}>Download CSV</Button>
        <Button variant="primary" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <article className="paper mx-auto max-w-[210mm] rounded-md border border-[#ccc] p-4 shadow-sm sm:p-6" data-testid="statement" aria-label="Account statement">
        <header className="border-b-2 border-[#111] pb-2">
          {company ? <p className="text-sm font-bold" dir="auto">{company}</p> : null}
          <h2 className="text-lg font-bold">Statement of account</h2>
        </header>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 print:grid-cols-2">
          <div>
            <p className="muted text-xs font-semibold tracking-wide">{kind === "CUSTOMER" ? "SHOP" : "SUPPLIER"}</p>
            <p className="text-left text-base font-semibold" dir="auto" data-testid="statement-party">{s.party.name}</p>
            {s.party.owner ? <p className="text-left text-sm" dir="auto">{s.party.owner}</p> : null}
            {s.party.region ? <p className="muted text-left text-sm" dir="auto">{s.party.region}</p> : null}
            {s.party.phone ? <p className="muted text-sm">{s.party.phone}</p> : null}
          </div>
          <div className="text-sm">
            <p className="muted text-xs font-semibold tracking-wide">PERIOD</p>
            <p data-testid="statement-period">{period}</p>
          </div>
        </div>

        <p className="mt-3 text-sm" data-testid="statement-opening">
          <span className="font-semibold">Opening balance:</span> PKR {formatPaisaPlain(Math.abs(s.opening))} — {balanceWords(kind, s.opening)}
        </p>

        <div className="mt-2 hidden overflow-x-auto sm:block print:block">
          <table className="text-sm" data-testid="statement-table">
            <thead>
              <tr>
                <th className="text-xs">Date</th>
                <th className="text-xs">Ref</th>
                <th className="text-xs">Description</th>
                <th className="num text-xs">Qty</th>
                <th className="num text-xs">Debit</th>
                <th className="num text-xs">Credit</th>
                <th className="num text-xs">Balance</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted text-center">
                    No entries in this period.
                  </td>
                </tr>
              ) : (
                s.rows.map((r, i) => (
                  <tr key={`${i}:${r.source.id}`} data-testid="statement-row">
                    <td className="whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td className="font-mono text-xs">{r.ref}</td>
                    <td dir="auto" data-testid="statement-description">{r.detail ?? r.description}</td>
                    <td className="num" data-testid="statement-qty">{r.qtyLabel}</td>
                    <td className="num">{r.debitP ? formatPaisaPlain(r.debitP) : ""}</td>
                    <td className="num">{r.creditP ? formatPaisaPlain(r.creditP) : ""}</td>
                    <td className="num whitespace-nowrap">{balanceCell(kind, r.balanceP)}</td>
                  </tr>
                ))
              )}
              <tr>
                <td colSpan={3} className="text-right font-semibold">
                  Totals
                </td>
                <td />
                <td className="num font-semibold" data-testid="statement-total-debit">{formatPaisaPlain(s.totals.debitP)}</td>
                <td className="num font-semibold" data-testid="statement-total-credit">{formatPaisaPlain(s.totals.creditP)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>


        <div className="mt-2 sm:hidden print:hidden" data-testid="statement-cards">
          {s.rows.length === 0 ? (
            <p className="muted py-3 text-center text-sm">No entries in this period.</p>
          ) : (
            <ul className="divide-y divide-[#bbb] border-y border-[#bbb]">
              {s.rows.map((r, i) => (
                <li key={`${i}:${r.source.id}`} className="py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="whitespace-nowrap font-medium">{fmtDate(r.date)}</span>
                    <span className="num font-semibold">{balanceCell(kind, r.balanceP)}</span>
                  </div>
                  <p dir="auto" className="text-left">{r.detail ?? r.description}</p>
                  {r.qtyLabel !== "—" ? <p className="muted text-xs">Qty {r.qtyLabel}</p> : null}
                  <div className="muted flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-mono">{r.ref}</span>
                    <span className="num">
                      {r.debitP ? `Debit ${formatPaisaPlain(r.debitP)}` : `Credit ${formatPaisaPlain(r.creditP)}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-sm font-semibold">
            Totals: Debit {formatPaisaPlain(s.totals.debitP)} · Credit {formatPaisaPlain(s.totals.creditP)}
          </p>
          <p className="muted text-xs">The figure on the right of each entry is the running balance.</p>
        </div>

        <p className="mt-3 text-base font-bold" data-testid="statement-closing">
          Closing balance: PKR {formatPaisaPlain(Math.abs(s.closing))} — {balanceWords(kind, s.closing)}
        </p>
        <p className="muted mt-1 text-xs">
          {kind === "CUSTOMER"
            ? "A balance without a mark means the shop owes us; “Cr” means we owe the shop."
            : "A balance without a mark means we owe the supplier; “Dr” means the supplier owes us."}
        </p>
        {s.omittedReversed > 0 ? (
          <p className="muted mt-1 text-xs" data-testid="statement-omitted">
            {s.omittedReversed} reversed voucher{s.omittedReversed === 1 ? " is" : "s are"} not shown.
          </p>
        ) : null}
      </article>
    </div>
  );
}
