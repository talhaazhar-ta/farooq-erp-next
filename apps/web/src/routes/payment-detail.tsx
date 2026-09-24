import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { formatPaisaPlain, type PaymentDetail } from "@farooq/shared";
import { RequirePaymentsAccess } from "../components/guard";
import { EditAmountDialog, ReverseDialog } from "../components/correction-dialogs";
import { Badge, Banner, Button, ErrorLines, Loading } from "../components/ui";
import { useAuth } from "../lib/auth";
import { canCorrect } from "../lib/access";
import { ApiError } from "../lib/api";
import { fmtDate, fmtDateTime, fmtMoney, KIND_LABELS } from "../lib/format";
import { getPayment, keys } from "../lib/queries";

export function PaymentDetailPage() {
  return (
    <RequirePaymentsAccess>
      <PaymentDetailScreen />
    </RequirePaymentsAccess>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 border-b border-(--color-border) py-2 text-sm last:border-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className="text-(--color-text)">{children}</dd>
    </div>
  );
}

function PaymentDetailScreen() {
  const { id } = useParams({ from: "/shell/payments/$id" });
  const { user } = useAuth();
  const q = useQuery({ queryKey: keys.payment(id), queryFn: () => getPayment(id), retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2 });
  const [dialog, setDialog] = useState<"reverse" | "edit" | null>(null);

  if (q.isPending) return <Loading label="Loading voucher…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <BackLink />
        {notFound ? <Banner tone="warn" title="Payment not found">This voucher does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }

  const p: PaymentDetail = q.data;
  const reversed = p.status === "REVERSED";
  const statementType = p.partyType === "CUSTOMER" ? "customer" : "supplier";
  const mayCorrect = user ? canCorrect(user.role) : false;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-(--color-text)">
            <span className={reversed ? "line-through" : ""} data-testid="voucher-number">{p.receiptNumber}</span>
            <Badge tone={reversed ? "danger" : "ok"}>{reversed ? "Reversed" : "Posted"}</Badge>
          </h1>
          <p className="text-sm text-(--color-text-muted)">{KIND_LABELS[p.kind]}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/payments/$id/receipt" params={{ id: p.id }} className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)">
            {p.direction === "IN" ? "Print receipt" : "Print voucher"}
          </Link>
          <Link
            to="/statements"
            search={{ type: statementType, partyId: p.partyId }}
            className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)"
          >
            View statement
          </Link>
        </div>
      </div>

      {reversed ? (
        <Banner tone="error" title="This voucher was reversed" data-testid="reversed-banner">
          <p>
            {p.reversedAt ? `On ${fmtDateTime(p.reversedAt)}. ` : ""}
            {p.reverseReason ? `Reason: ${p.reverseReason}` : ""}
          </p>
          <p className="mt-1">It no longer counts in the party’s balance or statement.</p>
        </Banner>
      ) : null}

      <dl className="rounded-xl border border-(--color-border) bg-(--color-surface) px-4 py-1">
        <Row label={p.direction === "IN" ? "Received from" : "Paid to"}>
          <span dir="auto" className="block text-left font-medium">{p.partyNameSnapshot ?? p.partyName}</span>
          {p.partyName && p.partyNameSnapshot && p.partyName !== p.partyNameSnapshot ? (
            <span dir="auto" className="ml-2 text-(--color-text-muted)">(now {p.partyName})</span>
          ) : null}
          {p.partyOwnerSnapshot || p.regionSnapshot ? (
            <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">{[p.partyOwnerSnapshot, p.regionSnapshot].filter(Boolean).join(" · ")}</span>
          ) : null}
        </Row>
        <Row label="Amount">
          <b className={`num text-base ${reversed ? "line-through" : ""}`} data-testid="voucher-amount">{fmtMoney(p.amountP)}</b>
        </Row>
        <Row label="Date">{fmtDate(p.paymentDate)}</Row>
        <Row label="Method">{p.method || "—"}</Row>
        <Row label="Reference"><span dir="auto" className="font-mono text-xs">{p.reference || "—"}</span></Row>
        <Row label="Note"><span dir="auto">{p.note || "—"}</span></Row>
        <Row label="Recorded by">{p.receivedBy} · {fmtDateTime(p.createdAt)}</Row>
        {p.kind !== "paidToShops" ? (
          <Row label="On account">{p.unallocatedP > 0 && !reversed ? fmtMoney(p.unallocatedP) : "—"}</Row>
        ) : null}
      </dl>

      {p.allocations.length > 0 ? (
        <section aria-label="Applied to" className="rounded-xl border border-(--color-border) bg-(--color-surface)">
          <h2 className="border-b border-(--color-border) px-4 py-2 text-sm font-semibold">Applied to</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-(--color-text-muted)">
              <tr>
                <th className="px-4 py-1.5 font-medium">{p.partyType === "CUSTOMER" ? "Invoice" : "Purchase"}</th>
                <th className="num px-4 py-1.5 font-medium">Amount applied</th>
              </tr>
            </thead>
            <tbody>
              {p.allocations.map((a) => (
                <tr key={a.id} className="border-t border-(--color-border)">
                  <td className="px-4 py-1.5 font-mono text-xs">{a.documentNumber ?? "(draft)"}</td>
                  <td className="num px-4 py-1.5">{formatPaisaPlain(a.amountP)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {mayCorrect ? (
        <section aria-label="Corrections" className="space-y-2 rounded-xl border border-(--color-border) bg-(--color-surface) p-4">
          <h2 className="text-sm font-semibold">Corrections</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Button variant="danger" disabled={!p.actions.reverse.allowed} aria-describedby="reverse-reason" onClick={() => setDialog("reverse")}>
                Reverse voucher
              </Button>
              {!p.actions.reverse.allowed ? (
                <p id="reverse-reason" className="mt-1 text-xs text-(--color-text-muted)" data-testid="reverse-reason">
                  {p.actions.reverse.reason}
                </p>
              ) : null}
            </div>
            <div>
              <Button disabled={!p.actions.editAmount.allowed} aria-describedby="edit-reason" onClick={() => setDialog("edit")}>
                Edit amount
              </Button>
              {!p.actions.editAmount.allowed ? (
                <p id="edit-reason" className="mt-1 text-xs text-(--color-text-muted)" data-testid="edit-reason">
                  {p.actions.editAmount.reason}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {dialog === "reverse" ? <ReverseDialog payment={p} onClose={() => setDialog(null)} /> : null}
      {dialog === "edit" ? <EditAmountDialog payment={p} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/payments" className="text-sm text-(--color-primary) hover:underline">
      ← All payments
    </Link>
  );
}
