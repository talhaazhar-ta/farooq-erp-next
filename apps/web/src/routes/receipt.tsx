import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { formatPaisaPlain, RECEIPT_LABELS, type CompanyProfile, type Receipt } from "@farooq/shared";
import { RequirePaymentsAccess } from "../components/guard";
import { Banner, Button, ErrorLines, Loading } from "../components/ui";
import { ApiError } from "../lib/api";
import { balanceWords, fmtDate, moneyWithSide } from "../lib/format";
import { getReceipt, keys } from "../lib/queries";

export function ReceiptPage() {
  return (
    <RequirePaymentsAccess>
      <ReceiptScreen />
    </RequirePaymentsAccess>
  );
}

function ReceiptScreen() {
  const { id } = useParams({ from: "/shell/payments/$id/receipt" });
  const q = useQuery({ queryKey: keys.receipt(id), queryFn: () => getReceipt(id), retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2 });

  if (q.isPending) return <Loading label="Loading receipt…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <Link to="/payments" className="text-sm text-(--color-primary) hover:underline">
          ← All payments
        </Link>
        {notFound ? <Banner tone="warn" title="Payment not found">This voucher does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  const r = q.data;
  const statementType = r.party.type === "CUSTOMER" ? "customer" : "supplier";

  return (
    <div className="mx-auto max-w-[210mm] space-y-3">
      <div className="no-print flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link to="/payments/$id" params={{ id: r.paymentId }} className="text-sm text-(--color-primary) hover:underline">
          ← Voucher details
        </Link>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/statements"
            search={{ type: statementType, partyId: r.party.id }}
            className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)"
          >
            View statement
          </Link>
          <Button variant="primary" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      <ReceiptPaper r={r} />
    </div>
  );
}

function CompanyHeader({ c }: { c: CompanyProfile }) {
  const contact = [c.phone, c.shopPhone, c.whatsapp ? `WhatsApp ${c.whatsapp}` : null, c.email, c.website].filter(Boolean).join("  ·  ");
  const address = [c.address, c.city].filter(Boolean).join(", ");
  const ids = [c.ntn ? `NTN ${c.ntn}` : null, c.registrationNo ? `Reg. ${c.registrationNo}` : null].filter(Boolean).join("  ·  ");
  return (
    <header className="flex items-start gap-4 border-b-2 border-[#111] pb-3">
      {c.logoDataUrl ? (
        // never cropped: contain within a fixed box
        <img src={c.logoDataUrl} alt="" className="h-16 w-16 shrink-0 object-contain" />
      ) : (
        <div aria-hidden className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border-2 border-[#111] text-lg font-bold">
          {c.logoText}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-bold leading-tight" dir="auto" data-testid="company-name">
          {c.businessName ?? c.legalName ?? ""}
        </h2>
        {c.tagline || c.taglineUr ? (
          <p className="muted text-sm" dir="auto">
            {[c.tagline, c.taglineUr].filter(Boolean).join("  ·  ")}
          </p>
        ) : null}
        {address ? <p className="muted text-xs" dir="auto">{address}</p> : null}
        {contact ? <p className="muted text-xs">{contact}</p> : null}
        {ids ? <p className="muted text-xs">{ids}</p> : null}
      </div>
    </header>
  );
}

export function ReceiptPaper({ r }: { r: Receipt }) {
  const labels = r.kind === "RECEIPT" ? RECEIPT_LABELS.receipt : RECEIPT_LABELS.voucher;
  const partyKind = r.party.type;
  return (
    <article className="paper relative mx-auto rounded-md border border-[#ccc] p-6 shadow-sm" data-testid="receipt" aria-label={r.title}>
      <CompanyHeader c={r.company} />

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-bold tracking-wide" data-testid="receipt-title">
          {r.title}
        </h1>
        <span className="font-mono text-base font-semibold" data-testid="receipt-number">
          {r.number}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2">
        <section aria-label={r.party.label}>
          <p className="muted text-xs font-semibold tracking-wide">{r.party.label}</p>
          <p className="text-left text-base font-semibold" dir="auto" data-testid="receipt-party">
            {r.party.name}
          </p>
          {r.party.owner ? <p className="text-left text-sm" dir="auto">{r.party.owner}</p> : null}
          {r.party.region ? <p className="muted text-left text-sm" dir="auto">{r.party.region}</p> : null}
          {r.party.phone ? <p className="muted text-sm">{r.party.phone}</p> : null}
        </section>
        <section aria-label={r.labels.meta}>
          <p className="muted text-xs font-semibold tracking-wide">{r.labels.meta}</p>
          <table>
            <tbody>
              <MetaRow label={RECEIPT_LABELS.metaNumber} value={r.meta.receiptNumber} />
              <MetaRow label={RECEIPT_LABELS.metaDate} value={fmtDate(r.date)} />
              <MetaRow label={RECEIPT_LABELS.metaMethod} value={r.meta.method} />
              <MetaRow label={RECEIPT_LABELS.metaReference} value={r.meta.reference} />
              <MetaRow label={RECEIPT_LABELS.metaReceivedBy} value={r.meta.receivedBy} />
            </tbody>
          </table>
        </section>
      </div>

      <section aria-label="Applied to" className="mt-4">
        {r.allocations.length > 0 ? (
          <table data-testid="receipt-allocations">
            <thead>
              <tr>
                <th className="w-10 text-xs">{RECEIPT_LABELS.columns.sr}</th>
                <th className="text-xs">{r.party.type === "CUSTOMER" ? RECEIPT_LABELS.columns.document : "Applied to purchase"}</th>
                <th className="text-xs">{RECEIPT_LABELS.columns.documentDate}</th>
                <th className="num text-xs">{RECEIPT_LABELS.columns.amount}</th>
              </tr>
            </thead>
            <tbody>
              {r.allocations.map((a, i) => (
                <tr key={a.documentId}>
                  <td>{i + 1}</td>
                  <td className="font-mono text-xs">{a.documentNumber ?? "(draft)"}</td>
                  <td>{fmtDate(a.documentDate)}</td>
                  <td className="num">{formatPaisaPlain(a.amountP)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="text-right font-semibold">
                  {RECEIPT_LABELS.totalApplied}
                </td>
                <td className="num font-semibold">{formatPaisaPlain(r.totalAppliedP)}</td>
              </tr>
            </tbody>
          </table>
        ) : r.kind === "RECEIPT" ? (
          <p className="text-sm font-medium" data-testid="receipt-on-account">
            {RECEIPT_LABELS.onAccount}
          </p>
        ) : null}
      </section>

      <section className="mt-4 rounded-md border-2 border-[#111] px-4 py-3" aria-label={labels.amount}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">
            {r.amountLabel} <span className="ml-1" dir="rtl" lang="ur">{labels.amountUr}</span>
          </span>
          <span className="num text-xl font-bold" data-testid="receipt-amount">
            PKR {formatPaisaPlain(r.amountP)}
          </span>
        </div>
        <p className="muted mt-1 text-sm" data-testid="receipt-words">
          {r.amountInWords}
        </p>
      </section>

      {!r.cancelled && r.previousBalanceP !== null && r.remainingBalanceP !== null ? (
        <section aria-label="Balance" className="mt-3">
          <table>
            <tbody>
              <tr>
                <td>{RECEIPT_LABELS.previousBalance}</td>
                <td className="num" data-testid="receipt-prev">{moneyWithSide(partyKind, r.previousBalanceP)}</td>
                <td className="muted text-xs">{balanceWords(partyKind, r.previousBalanceP)}</td>
              </tr>
              <tr>
                <td className="font-semibold">
                  {RECEIPT_LABELS.remainingBalance} <span dir="rtl" lang="ur">{RECEIPT_LABELS.remainingBalanceUr}</span>
                </td>
                <td className="num font-semibold" data-testid="receipt-remaining">{moneyWithSide(partyKind, r.remainingBalanceP)}</td>
                <td className="muted text-xs">{balanceWords(partyKind, r.remainingBalanceP)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      ) : null}

      {r.notes ? (
        <p className="mt-3 text-sm" dir="auto">
          <span className="muted font-semibold">Notes: </span>
          {r.notes}
        </p>
      ) : null}

      <div className="mt-10 grid grid-cols-2 gap-10 text-center text-sm">
        {r.labels.signatures.map((s) => (
          <div key={s} className="border-t border-[#111] pt-1">
            {s}
          </div>
        ))}
      </div>
      <p className="muted mt-6 text-center text-xs">{r.labels.thanks}</p>
      <p className="muted text-center text-[10px]">{r.labels.terms}</p>

      {r.cancelled ? (
        <div aria-hidden={false} className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" data-testid="reversed-mark">
          <span className="-rotate-12 rounded-lg border-8 border-[#b3261e] px-8 py-2 text-6xl font-black tracking-widest text-[#b3261e] opacity-40">REVERSED</span>
          {r.reversal?.reason ? <span className="mt-2 rounded bg-white/80 px-2 text-sm text-[#b3261e]" dir="auto">{r.reversal.reason}</span> : null}
        </div>
      ) : null}
    </article>
  );
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <tr>
      <td className="muted w-28 text-xs">{label}</td>
      <td className="text-sm" dir="auto">
        {value}
      </td>
    </tr>
  );
}
