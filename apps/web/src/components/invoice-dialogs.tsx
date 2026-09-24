import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { InvoiceDetail, PartyLookupItem } from "@farooq/shared";
import { cancelInvoice, changeInvoiceShop, getBalance, getRegions, keys, saveInvoice } from "../lib/queries";
import { newIdempotencyKey } from "../lib/ids";
import { postPayloadOf } from "../lib/invoice-form";
import { fmtMoney } from "../lib/format";
import { cancelEffect, invoiceTitle, postedReceipts, shopMoveFigures, shopOf } from "../lib/invoice-view";
import { PartyCombobox } from "./party-combobox";
import { Banner, Button, Dialog, ErrorLines, Field, inputClass, useToast } from "./ui";

/** After any correction: every screen that shows this invoice, the shops' money or stock must refetch. */
export function useAfterInvoiceChange() {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.invoices }),
      qc.invalidateQueries({ queryKey: keys.payments }),
      qc.invalidateQueries({ queryKey: ["balance"] }),
      qc.invalidateQueries({ queryKey: ["outstanding"] }),
      qc.invalidateQueries({ queryKey: ["statement"] }),
      qc.invalidateQueries({ queryKey: keys.products }),
    ]);
  };
}

/**
 * Cancel a posted invoice / discard a draft. States the effect first and REQUIRES a reason (the server does too). When the
 * server refuses because money was received, the receipts are listed here with links to them.
 */
export function CancelInvoiceDialog({ invoice, onClose, onDone }: { invoice: InvoiceDetail; onClose: () => void; onDone?: () => void }) {
  const draft = invoice.status === "DRAFT";
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const after = useAfterInvoiceChange();
  const navigate = useNavigate();
  const toast = useToast();
  const busy = useRef(false);
  const title = invoiceTitle(invoice.number);
  const receipts = postedReceipts(invoice);

  const mutation = useMutation({
    mutationFn: () => cancelInvoice(invoice.id, { reason: reason.trim() }),
    onSuccess: async () => {
      onDone?.(); // e.g. the builder lets the coming navigation through: a discarded draft has nothing left to lose
      await after();
      toast(draft ? `Draft discarded` : `${title} cancelled. Stock has been returned and the balance reversed.`);
      onClose();
      void navigate({ to: "/invoices", search: {} });
    },
    onSettled: () => {
      busy.current = false;
    },
  });
  const reasonMissing = reason.trim() === "";

  function confirm() {
    setTouched(true);
    if (reasonMissing || busy.current || mutation.isPending) return;
    busy.current = true;
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={draft ? "Discard this draft?" : `Cancel ${title}?`}
      description={`${fmtMoney(invoice.totalP)} · ${shopOf(invoice)}`}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Banner tone="warn" title="What will happen">
          <ul className="list-disc space-y-1 pl-5">
            {cancelEffect(invoice).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Banner>
        <Field label="Reason" error={touched && reasonMissing ? "Enter a reason." : null}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={draft ? "e.g. entered by mistake" : "Why is this invoice being cancelled?"} dir="auto" className={inputClass} />
        </Field>
        {mutation.isError ? (
          <div className="space-y-2">
            <ErrorLines error={mutation.error} onRetry={confirm} />
            {!draft && receipts.length > 0 ? <ReceiptLinks receipts={receipts} /> : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-(--color-border) pt-4">
          <Button onClick={onClose}>{draft ? "Keep draft" : "Keep invoice"}</Button>
          <Button type="submit" variant="danger" disabled={reasonMissing || mutation.isPending}>
            {mutation.isPending ? "Working…" : draft ? "Discard draft" : "Cancel invoice"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The receipts taken against an invoice, each linking to its voucher (used where money received blocks a correction). */
export function ReceiptLinks({ receipts }: { receipts: InvoiceDetail["receipts"] }) {
  return (
    <div data-testid="receipt-links" className="rounded-lg border border-(--color-border) px-3 py-2 text-sm">
      <p className="font-medium">Receipts taken against this invoice</p>
      <ul className="mt-1 space-y-0.5">
        {receipts.map((r) => (
          <li key={r.paymentId}>
            <Link to="/payments/$id" params={{ id: r.paymentId }} className="font-mono text-xs text-(--color-primary) hover:underline">
              {r.receiptNumber}
            </Link>{" "}
            <span className="num text-xs text-(--color-text-muted)">{fmtMoney(r.allocatedP)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Change shop (port of the legacy `PANELS.changeshop`): old shop's balance now → after, the receipts that move with the
 * invoice, an Area filter and a blank-first shop picker (never pre-selected), the new shop's balance now → after, an
 * optional reason. Save stays off until a DIFFERENT shop is chosen; the server's refusals are shown verbatim.
 */
export function ChangeShopPanel({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const [regionId, setRegionId] = useState("");
  const [shop, setShop] = useState<PartyLookupItem | null>(null);
  const [reason, setReason] = useState("");
  const after = useAfterInvoiceChange();
  const toast = useToast();
  const busy = useRef(false);
  const title = invoiceTitle(invoice.number);

  const regions = useQuery({ queryKey: keys.regions, queryFn: getRegions, staleTime: 5 * 60_000 });
  const oldId = invoice.customerId;
  const oldBalance = useQuery({ queryKey: oldId ? keys.balance("customer", oldId) : ["balance", "none"], queryFn: () => getBalance("customer", oldId!), enabled: Boolean(oldId) });
  const newBalance = useQuery({ queryKey: shop ? keys.balance("customer", shop.id) : ["balance", "none"], queryFn: () => getBalance("customer", shop!.id), enabled: Boolean(shop) });

  const sameShop = shop !== null && shop.id === oldId;
  const figures = shopMoveFigures(invoice, oldBalance.data?.balanceP ?? 0, shop && !sameShop && newBalance.data ? newBalance.data.balanceP : null);
  const moving = postedReceipts(invoice);
  const canSave = shop !== null && !sameShop;

  const mutation = useMutation({
    mutationFn: () => changeInvoiceShop(invoice.id, { customerId: shop!.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: async (moved) => {
      await after();
      toast(`${moved.number ?? "The invoice"} now belongs to ${shopOf(moved) || shop!.name}.`);
      onClose();
    },
    onSettled: () => {
      busy.current = false;
    },
  });

  function save() {
    if (!canSave || busy.current || mutation.isPending) return;
    busy.current = true;
    mutation.mutate();
  }

  return (
    <Dialog open onClose={onClose} title="Change shop" description="Move this invoice to a different shop — nothing else on it changes." wide>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Banner tone="info" title={`${title} · ${fmtMoney(invoice.totalP)}`} data-testid="cs-old">
          <p>
            Now billed to <b dir="auto">{shopOf(invoice) || "—"}</b>. Its balance:{" "}
            {oldBalance.data ? (
              <>
                <span className="num" data-testid="cs-old-now">{fmtMoney(figures.oldBalanceNowP)}</span> → <b className="num" data-testid="cs-old-after">{fmtMoney(figures.oldBalanceAfterP)}</b>.
              </>
            ) : (
              "loading…"
            )}
          </p>
          {moving.length > 0 ? (
            <p data-testid="cs-moving">
              Moves with it: {moving.map((r) => `${r.receiptNumber} (${fmtMoney(r.allocatedP)})`).join(", ")}.
            </p>
          ) : null}
          <p className="mt-1 text-xs text-(--color-text-muted)">Lines, amounts, stock, the invoice number and the date stay exactly as they are.</p>
        </Banner>

        <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <Field label="Area">
            <select
              value={regionId}
              onChange={(e) => {
                setRegionId(e.target.value);
                setShop(null);
              }}
              className={inputClass}
            >
              <option value="">All areas</option>
              {(regions.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nameEn}
                </option>
              ))}
            </select>
          </Field>
          <div className="text-sm">
            <span className="mb-1 block font-medium">Correct shop</span>
            <PartyCombobox type="customer" value={shop} regionId={regionId} label="Correct shop" onChange={setShop} />
            {sameShop ? (
              <span role="alert" className="mt-1 block text-xs text-(--color-danger)">
                That is already the shop on this invoice.
              </span>
            ) : null}
          </div>
        </div>

        <Banner tone="info" data-testid="cs-new">
          {shop && !sameShop ? (
            newBalance.data ? (
              <p>
                <b dir="auto">{shop.name}</b> balance: <span className="num" data-testid="cs-new-now">{fmtMoney(figures.newBalanceNowP ?? 0)}</span> →{" "}
                <b className="num" data-testid="cs-new-after">{fmtMoney(figures.newBalanceAfterP ?? 0)}</b>
              </p>
            ) : (
              <p>Loading that shop’s balance…</p>
            )
          ) : (
            <p>Choose a shop to see how its balance changes.</p>
          )}
        </Banner>

        <Field label="Reason (optional)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. picked the wrong shop — recorded in the audit log" dir="auto" className={inputClass} />
        </Field>

        {mutation.isError ? <ErrorLines error={mutation.error} onRetry={save} title="The invoice could not be moved. Nothing was changed." /> : null}
        <div className="flex justify-end gap-2 border-t border-(--color-border) pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? "Moving invoice…" : "Move invoice"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Post a saved draft straight from its page. States what posting does FIRST (a number is assigned, the bags leave stock, the
 * shop's balance goes up), then sends ONE `PUT … mode: "post"` built from the draft as loaded (paid 0, the revision as loaded, a
 * fresh idempotency key). A refusal — the stock message, a missing rate — is shown verbatim and the dialog stays open.
 */
export function PostDraftDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const after = useAfterInvoiceChange();
  const toast = useToast();
  const busy = useRef(false);
  const key = useRef(newIdempotencyKey());

  const mutation = useMutation({
    mutationFn: async () => {
      const built = postPayloadOf(invoice, key.current);
      if (!built.ok) throw new Error(built.errors.join(" "));
      return saveInvoice(built.payload, invoice.id);
    },
    onSuccess: async (posted) => {
      key.current = newIdempotencyKey();
      await after();
      toast(`${posted.number ?? "The invoice"} posted. Stock and the shop’s balance are updated.`);
      onClose();
    },
    onSettled: () => {
      busy.current = false;
    },
  });

  function confirm() {
    if (busy.current || mutation.isPending) return;
    busy.current = true;
    mutation.mutate();
  }

  return (
    <Dialog open onClose={onClose} title="Post this invoice?" description={`${fmtMoney(invoice.totalP)} · ${shopOf(invoice)}`}>
      <div className="space-y-4">
        <Banner tone="warn" title="What will happen">
          <ul className="list-disc space-y-1 pl-5">
            <li>The invoice is given its own invoice number.</li>
            <li>
              The bags leave stock ({invoice.totalQuantity} in all, from the godown each line names).
            </li>
            <li>The shop’s balance goes up by {fmtMoney(invoice.totalP)}. Nothing is received now — to take money with the sale, open the draft with Edit instead.</li>
          </ul>
        </Banner>
        {mutation.isError ? <ErrorLines error={mutation.error} onRetry={confirm} title="This invoice cannot be posted yet — nothing has been changed" /> : null}
        <div className="flex justify-end gap-2 border-t border-(--color-border) pt-4">
          <Button onClick={onClose}>Not yet</Button>
          <Button variant="primary" onClick={confirm} disabled={mutation.isPending} data-testid="confirm-post">
            {mutation.isPending ? "Posting…" : "Post invoice"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
