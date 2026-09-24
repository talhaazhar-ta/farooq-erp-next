import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { formatPaisaPlain, type InvoiceAction, type InvoiceDetail } from "@farooq/shared";
import { RequireInvoicesAccess } from "../components/guard";
import { CancelInvoiceDialog, ChangeShopPanel, PostDraftDialog, ReceiptLinks } from "../components/invoice-dialogs";
import { Badge, Banner, Button, ErrorLines, Loading, useToast } from "../components/ui";
import { useAuth } from "../lib/auth";
import { canCorrectInvoice, canCreateInvoice, canDiscardDraft } from "../lib/access";
import { ApiError } from "../lib/api";
import { fmtDate, fmtDateTime, fmtMoney } from "../lib/format";
import { statusLabel, statusTone } from "../lib/invoice-filters";
import { invoiceTitle, shopOf } from "../lib/invoice-view";
import { newIdempotencyKey } from "../lib/ids";
import { useMediaQuery } from "../lib/media";
import { duplicateInvoice, getInvoice, getWarehouses, keys } from "../lib/queries";

export function InvoiceDetailPage() {
  return (
    <RequireInvoicesAccess>
      <InvoiceDetailScreen />
    </RequireInvoicesAccess>
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

const linkButton = "rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)";

function InvoiceDetailScreen() {
  const { id } = useParams({ from: "/shell/invoices/$id" });
  const { user } = useAuth();
  const q = useQuery({ queryKey: keys.invoice(id), queryFn: () => getInvoice(id), retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2 });
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });
  const [dialog, setDialog] = useState<"cancel" | "shop" | "post" | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const duplicate = useMutation({
    mutationFn: () => duplicateInvoice(id, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: async (copy) => {
      await qc.invalidateQueries({ queryKey: keys.invoices });
      toast(`New draft created from ${invoiceTitle(q.data?.number ?? null)}. Check it, then post it — it takes its own number then.`);
      void navigate({ to: "/invoices/$id/edit", params: { id: copy.id } });
    },
  });

  if (q.isPending) return <Loading label="Loading invoice…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <BackLink />
        {notFound ? <Banner tone="warn" title="Invoice not found">This invoice does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }

  const inv: InvoiceDetail = q.data;
  const draft = inv.status === "DRAFT";
  const cancelled = inv.status === "CANCELLED";
  const role = user?.role;
  // which correction buttons this role is offered at all; whether each is ALLOWED now, and why not, is the server's (`actions.*`)
  const offerCancel = role ? (draft ? canDiscardDraft(role) : canCorrectInvoice(role)) : false;
  const offerChangeShop = role ? canCorrectInvoice(role) && !draft : false;
  const productName = new Map(inv.lines.map((l) => [l.productId, l.descriptionEn ?? l.description ?? ""]));
  const warehouseName = new Map((warehouses.data ?? []).map((w) => [w.id, w.name]));
  // the profit block exists only for a role that holds PROFIT_VIEW: the KEY is absent for everyone else
  const profit = "profit" in inv ? inv.profit : undefined;
  const profitByLine = new Map((profit?.lines ?? []).map((l) => [l.lineId, l]));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-(--color-text)">
            <span className={cancelled ? "line-through" : ""} data-testid="invoice-number">
              {invoiceTitle(inv.number)}
            </span>
            <span data-testid="invoice-status">
              <Badge tone={statusTone(inv.status)}>{statusLabel(inv.status)}</Badge>
            </span>
            {!draft && !cancelled && statusLabel(inv.paymentStatus) !== statusLabel(inv.status) ? (
              <Badge tone={inv.paymentStatus === "PAID" ? "ok" : inv.paymentStatus === "PARTIAL" ? "warn" : "neutral"}>{statusLabel(inv.paymentStatus)}</Badge>
            ) : null}
          </h1>
          <p className="text-sm text-(--color-text-muted)">
            Sales invoice · {fmtDate(inv.date)}
            {inv.orderNumber ? ` · Order ${inv.orderNumber}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/invoices/$id/print" params={{ id: inv.id }} className={linkButton}>
            Print
          </Link>
          {inv.customerId ? (
            <Link to="/statements" search={{ type: "customer", partyId: inv.customerId }} className={linkButton}>
              View statement
            </Link>
          ) : null}
        </div>
      </div>

      {cancelled ? (
        <Banner tone="error" title="This invoice was cancelled" data-testid="cancelled-banner">
          <p>
            {inv.cancelledAt ? `On ${fmtDateTime(inv.cancelledAt)}. ` : ""}
            {inv.cancelReason ? `Reason: ${inv.cancelReason}` : ""}
          </p>
          <p className="mt-1">It no longer counts in the shop’s balance or statement, and its bags are back in stock.</p>
        </Banner>
      ) : null}
      {draft ? (
        <Banner tone="info" title="Draft" data-testid="draft-banner">
          Not issued yet: no invoice number, no stock and no entry in the shop’s account.
        </Banner>
      ) : null}

      <dl className="rounded-xl border border-(--color-border) bg-(--color-surface) px-4 py-1">
        <Row label="Shop">
          <span dir="auto" className="block text-left font-medium" data-testid="invoice-shop">
            {shopOf(inv)}
          </span>
          {inv.shop.contactPerson || inv.shop.region ? (
            <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">
              {[inv.shop.contactPerson, inv.shop.region].filter(Boolean).join(" · ")}
            </span>
          ) : null}
          {inv.shop.mobile ? <span className="block text-xs text-(--color-text-muted)">{inv.shop.mobile}</span> : null}
        </Row>
        <Row label="Date">{fmtDate(inv.date)}</Row>
        {inv.dueDate ? <Row label="Due date">{fmtDate(inv.dueDate)}</Row> : null}
        <Row label="Warehouse">{inv.warehouseName ?? "—"}</Row>
        <Row label="Salesperson">{inv.salesperson || "—"}</Row>
        {inv.dispatchNumber ? <Row label="Dispatch no.">{inv.dispatchNumber}</Row> : null}
        {inv.paymentMethod || inv.referenceNo ? (
          <Row label="Payment">
            {[inv.paymentMethod, inv.referenceNo].filter(Boolean).join(" · ")}
          </Row>
        ) : null}
        {!draft ? (
          <Row label="Shop’s balance before this sale">
            <span className="num">{fmtMoney(inv.previousBalanceP)}</span>
            <span className="ml-2 text-xs text-(--color-text-muted)">fixed when the invoice was posted</span>
          </Row>
        ) : null}
        <Row label="Recorded">{fmtDateTime(inv.createdAt)}</Row>
      </dl>

      <Lines inv={inv} profitByLine={profitByLine} />
      <Totals inv={inv} />

      {profit ? (
        <section aria-label="Profit" data-testid="profit-block" className="space-y-1 rounded-xl border border-(--color-border) bg-(--color-surface) p-4 text-sm">
          <h2 className="font-semibold">Profit</h2>
          {profit.profitP === null ? (
            <p data-testid="profit-total">Cost unknown — no line on this invoice has a purchase cost recorded, so its profit cannot be shown.</p>
          ) : (
            <p data-testid="profit-total">
              Profit <b className="num">{fmtMoney(profit.profitP)}</b>
              {profit.marginPct !== null ? <> · margin <b className="num">{profit.marginPct.toFixed(2)}%</b></> : null}
            </p>
          )}
          {!profit.complete && profit.unknownCostLines > 0 ? (
            <p className="text-(--color-text)" data-testid="profit-incomplete">
              Cost unknown on {profit.unknownCostLines} line{profit.unknownCostLines === 1 ? "" : "s"} — {profit.unknownCostLines === 1 ? "it is" : "they are"} left out of the profit and the margin, never counted as free.
            </p>
          ) : null}
          <p className="text-xs text-(--color-text-muted)">
            Goods margin after the discount given. Tax and delivery / loading / other charges are not margin. Cost is what the bags cost when they were sold.
          </p>
        </section>
      ) : null}

      <section aria-label="Receipts applied" className="rounded-xl border border-(--color-border) bg-(--color-surface)">
        <h2 className="border-b border-(--color-border) px-4 py-2 text-sm font-semibold">Receipts applied</h2>
        {inv.receipts.length === 0 ? (
          <p className="px-4 py-3 text-sm text-(--color-text-muted)">No money has been received against this invoice.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm" data-testid="receipts-table">
              <thead className="text-left text-xs text-(--color-text-muted)">
                <tr>
                  <th className="px-4 py-1.5 font-medium">Receipt</th>
                  <th className="px-4 py-1.5 font-medium">Date</th>
                  <th className="px-4 py-1.5 font-medium">Method</th>
                  <th className="num px-4 py-1.5 font-medium">Applied here</th>
                </tr>
              </thead>
              <tbody>
                {inv.receipts.map((r) => (
                  <tr key={r.paymentId} className="border-t border-(--color-border)" data-testid="receipt-row">
                    <td className="whitespace-nowrap px-4 py-1.5 font-mono text-xs">
                      <Link to="/payments/$id" params={{ id: r.paymentId }} className={r.status === "REVERSED" ? "text-(--color-primary) line-through hover:underline" : "text-(--color-primary) hover:underline"}>
                        {r.receiptNumber}
                      </Link>
                      {r.status === "REVERSED" ? (
                        <span className="ml-1.5">
                          <Badge tone="danger">Reversed</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5">{fmtDate(r.date)}</td>
                    <td dir="auto" className="px-4 py-1.5 text-left">{[r.method, r.reference].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="num px-4 py-1.5">{formatPaisaPlain(r.allocatedP)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {inv.notes || inv.description ? (
        <section aria-label="Notes" className="space-y-1 rounded-xl border border-(--color-border) bg-(--color-surface) p-4 text-sm">
          {inv.description ? (
            <p dir="auto" className="text-left">
              <span className="text-(--color-text-muted)">Description: </span>
              {inv.description}
            </p>
          ) : null}
          {inv.notes ? (
            <p dir="auto" className="text-left">
              <span className="text-(--color-text-muted)">Notes: </span>
              {inv.notes}
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Stock effect" className="rounded-xl border border-(--color-border) bg-(--color-surface)">
        <h2 className="border-b border-(--color-border) px-4 py-2 text-sm font-semibold">Stock effect</h2>
        {inv.stockMovements.length === 0 ? (
          <p className="px-4 py-3 text-sm text-(--color-text-muted)" data-testid="no-stock">
            {draft ? "A draft moves no stock." : inv.migrated ? "This invoice came from the old system; its stock effect is not listed here." : "No stock movements are recorded for this invoice."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm" data-testid="stock-table">
              <thead className="text-left text-xs text-(--color-text-muted)">
                <tr>
                  <th className="px-4 py-1.5 font-medium">Date</th>
                  <th className="px-4 py-1.5 font-medium">Product</th>
                  <th className="px-4 py-1.5 font-medium">Warehouse</th>
                  <th className="px-4 py-1.5 font-medium">What</th>
                  <th className="num px-4 py-1.5 font-medium">Bags</th>
                </tr>
              </thead>
              <tbody>
                {inv.stockMovements.map((m) => (
                  <tr key={m.id} className="border-t border-(--color-border)" data-testid="stock-row" data-kind={m.kind}>
                    <td className="whitespace-nowrap px-4 py-1.5">{fmtDate(m.date)}</td>
                    <td dir="auto" className="px-4 py-1.5 text-left">{productName.get(m.productId) ?? ""}</td>
                    <td className="px-4 py-1.5">{warehouseName.get(m.warehouseId) ?? ""}</td>
                    <td className="px-4 py-1.5 text-xs text-(--color-text-muted)">{stockKindLabel(m.kind)}</td>
                    <td className="num px-4 py-1.5" data-testid="stock-qty">{m.quantity > 0 ? `+${m.quantity}` : String(m.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Actions" className="space-y-3 rounded-xl border border-(--color-border) bg-(--color-surface) p-4">
        <h2 className="text-sm font-semibold">Actions</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {/* Edit and Post follow the server's verdict for editing (a disabled button says why, and is never hidden) */}
          <ActionButton action={inv.actions.edit} testId="edit" onClick={() => void navigate({ to: "/invoices/$id/edit", params: { id: inv.id } })}>
            {draft ? "Edit draft" : "Edit invoice"}
          </ActionButton>
          {draft && role && canCreateInvoice(role) ? (
            <ActionButton action={inv.actions.edit} testId="post" onClick={() => setDialog("post")}>
              Post invoice
            </ActionButton>
          ) : null}
          <ActionButton action={inv.actions.duplicate} testId="duplicate" onClick={() => duplicate.mutate()} busy={duplicate.isPending}>
            Duplicate
          </ActionButton>
          {offerCancel ? (
            <ActionButton action={inv.actions.cancel} testId="cancel" variant="danger" onClick={() => setDialog("cancel")}>
              {draft ? "Discard draft" : "Cancel invoice"}
            </ActionButton>
          ) : null}
          {offerChangeShop ? (
            <ActionButton action={inv.actions.changeShop} testId="change-shop" onClick={() => setDialog("shop")}>
              Change shop
            </ActionButton>
          ) : null}
        </div>
        {duplicate.isError ? <ErrorLines error={duplicate.error} /> : null}
        {offerCancel && !draft && !inv.actions.cancel.allowed && inv.receipts.some((r) => r.status === "POSTED") ? <ReceiptLinks receipts={inv.receipts.filter((r) => r.status === "POSTED")} /> : null}
      </section>

      {dialog === "cancel" ? <CancelInvoiceDialog invoice={inv} onClose={() => setDialog(null)} /> : null}
      {dialog === "shop" ? <ChangeShopPanel invoice={inv} onClose={() => setDialog(null)} /> : null}
      {dialog === "post" ? <PostDraftDialog invoice={inv} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

/** A button drawn from the server's verdict: disabled with the server's own reason underneath, never a client-side guess. */
function ActionButton({
  action,
  testId,
  onClick,
  children,
  variant = "secondary",
  busy = false,
}: {
  action: InvoiceAction;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
  variant?: "secondary" | "danger";
  busy?: boolean;
}) {
  return (
    <div>
      <Button variant={variant} disabled={!action.allowed || busy} aria-describedby={`${testId}-reason`} data-testid={`action-${testId}`} onClick={onClick}>
        {busy ? "Working…" : children}
      </Button>
      {!action.allowed ? (
        <p id={`${testId}-reason`} className="mt-1 text-xs text-(--color-text-muted)" data-testid={`reason-${testId}`}>
          {action.reason}
        </p>
      ) : null}
    </div>
  );
}

const STOCK_KINDS: Record<string, string> = {
  SALE_OUT: "Sold — bags out",
  SALE_REVERSAL_IN: "Cancelled — bags back in",
  INVOICE_EDIT_OUT: "Invoice edited — more bags out",
  INVOICE_EDIT_IN: "Invoice edited — bags back in",
  CUSTOMER_RETURN_IN: "Returned by the shop",
  CUSTOMER_RETURN_DAMAGED_IN: "Returned damaged",
};
/** What a stock movement was, in words (an unknown kind is shown as it is, lower-cased). */
const stockKindLabel = (kind: string): string => STOCK_KINDS[kind] ?? kind.toLowerCase().replace(/_/g, " ");

type ProfitLine = NonNullable<InvoiceDetail["profit"]>["lines"][number];

function profitCell(p: ProfitLine | undefined): string {
  if (!p) return "";
  if (!p.costKnown || p.profitP === null) return "cost unknown";
  return `${fmtMoney(p.profitP)}${p.marginPct !== null ? ` · ${p.marginPct.toFixed(1)}%` : ""}`;
}

function Lines({ inv, profitByLine }: { inv: InvoiceDetail; profitByLine: Map<string, ProfitLine> }) {
  const withProfit = "profit" in inv;
  const wide = useMediaQuery("(min-width: 640px)"); // a table on a wide screen, cards on a phone — only one of them is in the page
  return (
    <section aria-label="Lines" className="rounded-xl border border-(--color-border) bg-(--color-surface)">
      <h2 className="border-b border-(--color-border) px-4 py-2 text-sm font-semibold">
        Lines <span className="font-normal text-(--color-text-muted)">· {inv.lineCount} item{inv.lineCount === 1 ? "" : "s"}, {inv.totalQuantity} bags</span>
      </h2>
      {inv.lines.length === 0 ? (
        <p className="px-4 py-3 text-sm text-(--color-text-muted)" data-testid="no-lines">
          This invoice has no lines on file{inv.migrated ? " (it came from the old system)" : ""}.
        </p>
      ) : (
        <>
          {wide ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm" data-testid="lines-table">
              <thead className="text-left text-xs text-(--color-text-muted)">
                <tr>
                  <th className="px-4 py-1.5 font-medium">Product</th>
                  <th className="px-4 py-1.5 font-medium">Pack</th>
                  <th className="num px-4 py-1.5 font-medium">Qty</th>
                  <th className="num px-4 py-1.5 font-medium">Rate</th>
                  <th className="num px-4 py-1.5 font-medium">Discount</th>
                  <th className="num px-4 py-1.5 font-medium">Amount</th>
                  {withProfit ? <th className="px-4 py-1.5 font-medium">Profit</th> : null}
                </tr>
              </thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id} className="border-t border-(--color-border) align-top" data-testid="line-row">
                    <td className="px-4 py-1.5">
                      <span dir="auto" className="block text-left font-medium">{l.descriptionEn ?? l.description}</span>
                      {l.description && l.descriptionEn && l.description !== l.descriptionEn ? <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">{l.description}</span> : null}
                      {l.brand ? <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">{l.brand}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5">{l.package ?? ""}</td>
                    <td className="num px-4 py-1.5">{l.quantity}</td>
                    <td className="num px-4 py-1.5">{formatPaisaPlain(l.unitPriceP)}</td>
                    <td className="num px-4 py-1.5">{l.discountP ? formatPaisaPlain(l.discountP) : "—"}</td>
                    <td className="num px-4 py-1.5 font-semibold">{formatPaisaPlain(l.lineTotalP)}</td>
                    {withProfit ? (
                      <td className="whitespace-nowrap px-4 py-1.5 text-xs" data-testid="line-profit">
                        {profitCell(profitByLine.get(l.id))}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          ) : (
          <ul className="divide-y divide-(--color-border)" data-testid="line-cards">
            {inv.lines.map((l) => (
              <li key={l.id} className="px-4 py-2 text-sm" data-testid="line-row">
                <div className="flex items-start justify-between gap-3">
                  <span dir="auto" className="min-w-0 text-left font-medium">{l.descriptionEn ?? l.description}</span>
                  <span className="num shrink-0 font-semibold">{formatPaisaPlain(l.lineTotalP)}</span>
                </div>
                <p className="text-xs text-(--color-text-muted)">
                  {l.package ? `${l.package} · ` : ""}
                  {l.quantity} × <span className="num">{formatPaisaPlain(l.unitPriceP)}</span>
                  {l.discountP ? ` · discount ${formatPaisaPlain(l.discountP)}` : ""}
                </p>
                {withProfit ? (
                  <p className="text-xs" data-testid="line-profit">
                    {profitCell(profitByLine.get(l.id))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          )}
        </>
      )}
    </section>
  );
}

function Totals({ inv }: { inv: InvoiceDetail }) {
  const rows: [string, number, boolean][] = [
    ["Subtotal", inv.subtotalP, true],
    ["Item discounts", -inv.itemDiscountsP, inv.itemDiscountsP > 0],
    ["Invoice discount", -inv.invoiceDiscountP, inv.invoiceDiscountP > 0],
    ["Tax", inv.taxP, inv.taxP > 0],
    ["Delivery / freight", inv.freightP, inv.freightP > 0],
    ["Loading / unloading", inv.loadingP, inv.loadingP > 0],
    ["Other charges", inv.otherChargesP, inv.otherChargesP > 0],
  ];
  const posted = inv.status !== "DRAFT" && inv.status !== "CANCELLED";
  return (
    <section aria-label="Totals" className="ml-auto max-w-md rounded-xl border border-(--color-border) bg-(--color-surface) px-4 py-2 text-sm">
      <dl data-testid="totals">
        {rows
          .filter(([, , show]) => show)
          .map(([label, amount]) => (
            <div key={label} className="flex justify-between gap-4 py-0.5">
              <dt className="text-(--color-text-muted)">{label}</dt>
              <dd className="num">{amount < 0 ? `− ${formatPaisaPlain(-amount)}` : formatPaisaPlain(amount)}</dd>
            </div>
          ))}
        <div className="flex justify-between gap-4 border-t border-(--color-border) py-1 text-base font-bold">
          <dt>Grand total</dt>
          <dd className="num" data-testid="grand-total">{formatPaisaPlain(inv.totalP)}</dd>
        </div>
        {posted ? (
          <>
            <div className="flex justify-between gap-4 py-0.5">
              <dt className="text-(--color-text-muted)">Received</dt>
              <dd className="num" data-testid="paid-total">{formatPaisaPlain(inv.paidP)}</dd>
            </div>
            <div className="flex justify-between gap-4 py-0.5 font-semibold">
              <dt>Balance on this invoice</dt>
              <dd className="num" data-testid="balance-total">{formatPaisaPlain(inv.outstandingP)}</dd>
            </div>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function BackLink() {
  return (
    <Link to="/invoices" className="text-sm text-(--color-primary) hover:underline">
      ← All invoices
    </Link>
  );
}
