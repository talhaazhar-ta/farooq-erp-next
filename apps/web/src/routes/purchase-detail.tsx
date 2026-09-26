import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { formatPaisaPlain, type PurchaseAction, type PurchaseDetail } from "@farooq/shared";
import { RequirePurchasesAccess } from "../components/guard";
import { Badge, Banner, Button, ErrorLines, Loading } from "../components/ui";
import { ApiError } from "../lib/api";
import { fmtDate, fmtDateTime, fmtMoney } from "../lib/format";
import { useMediaQuery } from "../lib/media";
import { bagsText, payLabel, payTone, purchaseStatusLabel, purchaseStatusTone } from "../lib/purchase-filters";
import { getPurchase, getWarehouses, keys } from "../lib/queries";

export function PurchaseDetailPage() {
  return (
    <RequirePurchasesAccess>
      <PurchaseDetailScreen />
    </RequirePurchasesAccess>
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

function PurchaseDetailScreen() {
  const { id } = useParams({ from: "/shell/purchases/$id" });
  const navigate = useNavigate();
  const q = useQuery({ queryKey: keys.purchase(id), queryFn: () => getPurchase(id), retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2 });
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });

  if (q.isPending) return <Loading label="Loading purchase…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <BackLink />
        {notFound ? <Banner tone="warn" title="Purchase not found">This purchase does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }

  const pu: PurchaseDetail = q.data;
  const cancelled = pu.status === "CANCELLED";
  const whName = new Map((warehouses.data ?? []).map((w) => [w.id, w.name]));
  const productName = new Map(pu.lines.map((l) => [l.productId, l.descriptionEn ?? l.description ?? ""]));
  // the cost block exists only for a role that holds PROFIT_VIEW: the KEY is absent for everyone else
  const costs = "costs" in pu ? pu.costs : undefined;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-(--color-text)">
            <span className={cancelled ? "line-through" : ""} data-testid="purchase-number">
              {pu.number ?? "Purchase"}
            </span>
            <span data-testid="purchase-status">
              <Badge tone={purchaseStatusTone(pu.status)}>{purchaseStatusLabel(pu.status)}</Badge>
            </span>
            {!cancelled ? (
              <span data-testid="purchase-pay">
                <Badge tone={payTone(pu.paymentStatus)}>{payLabel(pu.paymentStatus)}</Badge>
              </span>
            ) : null}
          </h1>
          <p className="text-sm text-(--color-text-muted)">
            Purchase · {fmtDate(pu.date)}
            {pu.supplierInvoiceNo ? ` · supplier’s bill ${pu.supplierInvoiceNo}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/purchases/$id/print" params={{ id: pu.id }} className={linkButton}>
            Print
          </Link>
          {pu.supplierId ? (
            <Link to="/statements" search={{ type: "supplier", partyId: pu.supplierId }} className={linkButton}>
              Supplier statement
            </Link>
          ) : null}
        </div>
      </div>

      {cancelled ? (
        <Banner tone="error" title="This purchase was cancelled" data-testid="cancelled-banner">
          It is not owed to the supplier and its bags are not in stock.
        </Banner>
      ) : null}
      {pu.status === "ORDERED" ? (
        <Banner tone="info" title="Ordered — nothing has arrived yet" data-testid="ordered-banner">
          The bill is on the supplier’s account; no bags are in stock from it.
        </Banner>
      ) : null}
      {pu.status === "DRAFT" ? (
        <Banner tone="info" title="Draft (from the old system)" data-testid="draft-banner">
          It still counts on the supplier’s account. Saving it gives it its real state from the bags received.
        </Banner>
      ) : null}

      <dl className="rounded-xl border border-(--color-border) bg-(--color-surface) px-4 py-1">
        <Row label="Supplier">
          <span dir="auto" className="block text-left font-medium" data-testid="purchase-supplier">
            {pu.supplierName ?? "—"}
          </span>
          {pu.supplierCurrentName && pu.supplierCurrentName !== pu.supplierName ? (
            <span dir="auto" className="block text-left text-xs text-(--color-text-muted)" data-testid="supplier-now">
              Now called {pu.supplierCurrentName}
            </span>
          ) : null}
        </Row>
        {pu.supplierBalanceP !== null ? (
          <Row label="Supplier’s balance now">
            <span className="num" data-testid="supplier-balance">
              {fmtMoney(pu.supplierBalanceP)}
            </span>
            <span className="ml-2 text-xs text-(--color-text-muted)">{pu.supplierBalanceP > 0 ? "we owe them" : pu.supplierBalanceP < 0 ? "they owe us" : "settled"} — all bills and payments</span>
          </Row>
        ) : null}
        <Row label="Supplier’s bill no.">{pu.supplierInvoiceNo || "—"}</Row>
        <Row label="Date">{fmtDate(pu.date)}</Row>
        <Row label="Warehouse">{pu.warehouseName ?? "—"}</Row>
        {pu.vehicleNo || pu.driver ? <Row label="Vehicle / driver">{[pu.vehicleNo, pu.driver].filter(Boolean).join(" · ")}</Row> : null}
        {pu.deliveryRef ? <Row label="Delivery ref">{pu.deliveryRef}</Row> : null}
        <Row label="Bags">
          <span data-testid="purchase-bags">
            {bagsText(pu.receivedQuantity)} received of {bagsText(pu.orderedQuantity)} ordered
          </span>
        </Row>
        <Row label="Recorded">{fmtDateTime(pu.createdAt)}</Row>
      </dl>

      <Lines pu={pu} whName={whName} />
      <Totals pu={pu} />

      {costs ? (
        <section aria-label="Cost" data-testid="cost-block" className="space-y-2 rounded-xl border border-(--color-border) bg-(--color-surface) p-4 text-sm">
          <h2 className="font-semibold">Cost</h2>
          <p className="text-xs text-(--color-text-muted)">
            {costs.basis === "LANDED" ? "Landed cost: the rate plus each bag’s share of the charges." : "Purchase price: the rate only."} The average is over every purchase of that product into that warehouse.
          </p>
          <ul className="space-y-1" data-testid="cost-rows">
            {costs.stock.map((s) => (
              <li key={`${s.productId}:${s.warehouseId}`} className="flex flex-wrap justify-between gap-2">
                <span dir="auto" className="text-left">
                  {productName.get(s.productId) ?? ""} · {whName.get(s.warehouseId) ?? ""}
                </span>
                <span className="num">
                  average {formatPaisaPlain(s.avgCostP)} · last {formatPaisaPlain(s.lastCostP)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Payments" className="rounded-xl border border-(--color-border) bg-(--color-surface)">
        <h2 className="border-b border-(--color-border) px-4 py-2 text-sm font-semibold">Payments to the supplier against this bill</h2>
        {pu.payments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-(--color-text-muted)">Nothing has been paid against this purchase.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm" data-testid="payments-table">
              <thead className="text-left text-xs text-(--color-text-muted)">
                <tr>
                  <th className="px-4 py-1.5 font-medium">Voucher</th>
                  <th className="px-4 py-1.5 font-medium">Date</th>
                  <th className="px-4 py-1.5 font-medium">Method</th>
                  <th className="num px-4 py-1.5 font-medium">Applied here</th>
                </tr>
              </thead>
              <tbody>
                {pu.payments.map((v) => (
                  <tr key={v.paymentId} className="border-t border-(--color-border)" data-testid="payment-row">
                    <td className="whitespace-nowrap px-4 py-1.5 font-mono text-xs">
                      <Link to="/payments/$id" params={{ id: v.paymentId }} className={v.status === "REVERSED" ? "text-(--color-primary) line-through hover:underline" : "text-(--color-primary) hover:underline"}>
                        {v.receiptNumber}
                      </Link>
                      {v.status === "REVERSED" ? (
                        <span className="ml-1.5">
                          <Badge tone="danger">Reversed</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5">{fmtDate(v.date)}</td>
                    <td dir="auto" className="px-4 py-1.5 text-left">{[v.method, v.reference].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="num px-4 py-1.5">{formatPaisaPlain(v.allocatedP)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pu.notes || pu.description ? (
        <section aria-label="Notes" className="space-y-1 rounded-xl border border-(--color-border) bg-(--color-surface) p-4 text-sm">
          {pu.description ? (
            <p dir="auto" className="text-left">
              <span className="text-(--color-text-muted)">Description: </span>
              {pu.description}
            </p>
          ) : null}
          {pu.notes ? (
            <p dir="auto" className="text-left">
              <span className="text-(--color-text-muted)">Notes: </span>
              {pu.notes}
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Stock effect" className="rounded-xl border border-(--color-border) bg-(--color-surface)">
        <h2 className="border-b border-(--color-border) px-4 py-2 text-sm font-semibold">Stock effect</h2>
        {pu.stockMovements.length === 0 ? (
          <p className="px-4 py-3 text-sm text-(--color-text-muted)" data-testid="no-stock">
            {pu.receivedQuantity === 0 ? "Nothing has arrived, so no bags went into stock." : "No stock movements are recorded for this purchase."}
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
                {pu.stockMovements.map((m) => (
                  <tr key={m.id} className="border-t border-(--color-border)" data-testid="stock-row" data-kind={m.kind}>
                    <td className="whitespace-nowrap px-4 py-1.5">{fmtDate(m.date)}</td>
                    <td dir="auto" className="px-4 py-1.5 text-left">{productName.get(m.productId) ?? ""}</td>
                    <td className="px-4 py-1.5">{whName.get(m.warehouseId) ?? ""}</td>
                    <td className="px-4 py-1.5 text-xs text-(--color-text-muted)">{stockKindLabel(m.kind, m.refType)}</td>
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
        <div className="grid gap-3 sm:grid-cols-2">
          <ActionButton action={pu.actions.edit} testId="edit" onClick={() => void navigate({ to: "/purchases/$id/edit", params: { id: pu.id } })}>
            Edit purchase
          </ActionButton>
          <ActionButton action={pu.actions.changeSupplier} testId="change-supplier" onClick={() => void navigate({ to: "/purchases/$id/edit", params: { id: pu.id } })} allowedNote="Open Edit purchase and choose another supplier there.">
            Change supplier
          </ActionButton>
        </div>
      </section>
    </div>
  );
}

/**
 * A button drawn from the server's verdict: when the server refuses, disabled with its own reason underneath; when it allows, the
 * button opens the purchase form (`allowedNote` says what the button does when that is not obvious from its name).
 */
function ActionButton({ action, testId, onClick, allowedNote, children }: { action: PurchaseAction; testId: string; onClick: () => void; allowedNote?: string; children: React.ReactNode }) {
  return (
    <div>
      <Button disabled={!action.allowed} onClick={onClick} aria-describedby={`${testId}-reason`} data-testid={`action-${testId}`} data-allowed={action.allowed ? "true" : "false"}>
        {children}
      </Button>
      <p id={`${testId}-reason`} className="mt-1 text-xs text-(--color-text-muted)" data-testid={`reason-${testId}`}>
        {action.allowed ? (allowedNote ?? "") : action.reason}
      </p>
    </div>
  );
}

const STOCK_KINDS: Record<string, string> = {
  PURCHASE_IN: "Received — bags in",
  PURCHASE_REVERSAL_OUT: "Purchase changed — bags out",
};
function stockKindLabel(kind: string, refType: string | null): string {
  if (kind === "PURCHASE_IN" && refType === "PURCHASE_EDIT") return "Purchase changed — more bags in";
  return STOCK_KINDS[kind] ?? kind.toLowerCase().replace(/_/g, " ");
}

function Lines({ pu, whName }: { pu: PurchaseDetail; whName: Map<string, string> }) {
  const withCost = pu.lines.some((l) => "landedUnitCostP" in l);
  const wide = useMediaQuery("(min-width: 640px)");
  return (
    <section aria-label="Lines" className="rounded-xl border border-(--color-border) bg-(--color-surface)">
      <h2 className="border-b border-(--color-border) px-4 py-2 text-sm font-semibold">
        Lines <span className="font-normal text-(--color-text-muted)">· {pu.lineCount} item{pu.lineCount === 1 ? "" : "s"}</span>
      </h2>
      {pu.lines.length === 0 ? (
        <p className="px-4 py-3 text-sm text-(--color-text-muted)" data-testid="no-lines">
          This purchase has no lines on file{pu.migrated ? " (it came from the old system)" : ""}.
        </p>
      ) : wide ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm" data-testid="lines-table">
            <thead className="text-left text-xs text-(--color-text-muted)">
              <tr>
                <th className="px-4 py-1.5 font-medium">Product</th>
                <th className="px-4 py-1.5 font-medium">Warehouse</th>
                <th className="num px-4 py-1.5 font-medium">Ordered</th>
                <th className="num px-4 py-1.5 font-medium">Received</th>
                <th className="num px-4 py-1.5 font-medium">Returned</th>
                <th className="num px-4 py-1.5 font-medium">Rate</th>
                <th className="num px-4 py-1.5 font-medium">Discount</th>
                <th className="num px-4 py-1.5 font-medium">Amount</th>
                {withCost ? <th className="num px-4 py-1.5 font-medium">Landed / bag</th> : null}
              </tr>
            </thead>
            <tbody>
              {pu.lines.map((l) => (
                <tr key={l.id} className="border-t border-(--color-border) align-top" data-testid="line-row">
                  <td className="px-4 py-1.5">
                    <span dir="auto" className="block text-left font-medium">{l.descriptionEn ?? l.description}</span>
                    {l.description && l.descriptionEn && l.description !== l.descriptionEn ? <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">{l.description}</span> : null}
                    <span className="block text-xs text-(--color-text-muted)">{[l.brand, l.package].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-1.5">{whName.get(l.warehouseId) ?? ""}</td>
                  <td className="num px-4 py-1.5" data-testid="line-ordered">{bagsText(l.quantity)}</td>
                  <td className="num px-4 py-1.5" data-testid="line-received">{bagsText(l.receivedQuantity)}</td>
                  <td className="num px-4 py-1.5" data-testid="line-returned">{l.returnedQuantity ? bagsText(l.returnedQuantity) : "—"}</td>
                  <td className="num px-4 py-1.5">{formatPaisaPlain(l.unitPriceP)}</td>
                  <td className="num px-4 py-1.5">{l.discountP ? formatPaisaPlain(l.discountP) : "—"}</td>
                  <td className="num px-4 py-1.5 font-semibold">{formatPaisaPlain(l.lineTotalP)}</td>
                  {withCost ? (
                    <td className="num px-4 py-1.5 text-xs" data-testid="line-cost">
                      {l.landedUnitCostP != null ? formatPaisaPlain(l.landedUnitCostP) : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="divide-y divide-(--color-border)" data-testid="line-cards">
          {pu.lines.map((l) => (
            <li key={l.id} className="px-4 py-2 text-sm" data-testid="line-row">
              <div className="flex items-start justify-between gap-3">
                <span dir="auto" className="min-w-0 text-left font-medium">{l.descriptionEn ?? l.description}</span>
                <span className="num shrink-0 font-semibold">{formatPaisaPlain(l.lineTotalP)}</span>
              </div>
              <p className="text-xs text-(--color-text-muted)">
                <span data-testid="line-received">{bagsText(l.receivedQuantity)}</span> received of <span data-testid="line-ordered">{bagsText(l.quantity)}</span> ordered
                {l.returnedQuantity ? ` · ${bagsText(l.returnedQuantity)} returned` : ""} · {whName.get(l.warehouseId) ?? ""}
              </p>
              <p className="text-xs text-(--color-text-muted)">
                {l.package ? `${l.package} · ` : ""}rate <span className="num">{formatPaisaPlain(l.unitPriceP)}</span>
                {l.discountP ? ` · discount ${formatPaisaPlain(l.discountP)}` : ""}
                {withCost && l.landedUnitCostP != null ? <span data-testid="line-cost"> · landed {formatPaisaPlain(l.landedUnitCostP)}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Totals({ pu }: { pu: PurchaseDetail }) {
  const rows: [string, number, boolean][] = [
    ["Subtotal", pu.subtotalP, true],
    ["Discounts", -pu.discountAmountP, pu.discountAmountP > 0],
    ["Tax", pu.taxP, pu.taxP > 0],
    ["Freight", pu.freightP, pu.freightP > 0],
    ["Loading / unloading", pu.loadingP, pu.loadingP > 0],
    ["Other charges", pu.otherChargesP, pu.otherChargesP > 0],
  ];
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
          <dd className="num" data-testid="grand-total">{formatPaisaPlain(pu.totalP)}</dd>
        </div>
        {pu.status !== "CANCELLED" ? (
          <>
            <div className="flex justify-between gap-4 py-0.5">
              <dt className="text-(--color-text-muted)">Paid</dt>
              <dd className="num" data-testid="paid-total">{formatPaisaPlain(pu.paidP)}</dd>
            </div>
            <div className="flex justify-between gap-4 py-0.5 font-semibold">
              <dt>Payable to supplier</dt>
              <dd className="num" data-testid="balance-total">{formatPaisaPlain(pu.balanceP)}</dd>
            </div>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function BackLink() {
  return (
    <Link to="/purchases" className="text-sm text-(--color-primary) hover:underline">
      ← All purchases
    </Link>
  );
}
