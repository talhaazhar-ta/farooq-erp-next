import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  businessDateOf,
  formatPaisa,
  formatPaisaPlain,
  parseRupees,
  type OutstandingDocument,
  type PartyLookupItem,
  type PaymentVoucher,
} from "@farooq/shared";
import { getBalance, getOutstanding, getRegions, keys, payPayment, receivePayment, refundPayment } from "../lib/queries";
import { autoAllocate, fillAmount, hasManualProblems, manualAllocation } from "../lib/allocation";
import { newIdempotencyKey } from "../lib/ids";
import { PAYMENT_METHODS } from "../lib/payment-filters";
import { balanceWords, fmtDate, fmtMoney } from "../lib/format";
import { PartyCombobox } from "./party-combobox";
import { Banner, Button, Dialog, ErrorLines, Field, inputClass, Loading, useToast } from "./ui";

export type PanelMode = "receive" | "pay" | "refund";

const COPY: Record<PanelMode, { title: string; subtitle: string; cta: string; partyLabel: string; amountLabel: string; type: "customer" | "supplier"; noun: string }> = {
  receive: { title: "Receive payment", subtitle: "Money received from a shop", cta: "Record payment & open receipt", partyLabel: "Shop", amountLabel: "Amount received", type: "customer", noun: "shop" },
  pay: { title: "Pay supplier", subtitle: "Money paid to a supplier", cta: "Record payment & open voucher", partyLabel: "Supplier", amountLabel: "Amount paid", type: "supplier", noun: "supplier" },
  refund: { title: "Pay a shop", subtitle: "Money paid out to a shop — a refund or adjustment, not tied to a return", cta: "Record payment & open voucher", partyLabel: "Shop", amountLabel: "Amount paid", type: "customer", noun: "shop" },
};

/**
 * The three money panels in one form: Receive (shop → us, with invoice allocation), Pay supplier, Pay a shop (refund).
 * Rules carried from the legacy: no party is ever pre-selected; Save is refused until a party and a valid amount exist;
 * a second click on Save does nothing (and the request carries an idempotency key, so even a retry cannot double-post);
 * the server's refusal is shown verbatim, every line.
 */
export function PaymentPanel({ mode, onClose }: { mode: PanelMode; onClose: () => void }) {
  const copy = COPY[mode];
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const [party, setParty] = useState<PartyLookupItem | null>(null);
  const [area, setArea] = useState("");
  const [amountText, setAmountText] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [method, setMethod] = useState<string>("Cash");
  const [date, setDate] = useState(() => businessDateOf(new Date()));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [allocMode, setAllocMode] = useState<"auto" | "manual">("auto");
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  // One key per opening of the panel: a repeated request (double click, retry after a dropped answer) returns the first voucher.
  const keyRef = useRef(newIdempotencyKey());
  const busy = useRef(false);

  const regions = useQuery({ queryKey: keys.regions, queryFn: getRegions, staleTime: 5 * 60_000, enabled: copy.type === "customer" });
  const balance = useQuery({
    queryKey: party ? keys.balance(copy.type, party.id) : ["balance", "none"],
    queryFn: () => getBalance(copy.type, party!.id),
    enabled: party !== null,
  });
  const outstanding = useQuery({
    queryKey: party ? keys.outstanding(party.id) : ["outstanding", "none"],
    queryFn: () => getOutstanding("customer", party!.id),
    enabled: mode === "receive" && party !== null,
  });

  const parsed = amountText.trim() ? parseRupees(amountText) : null;
  const amountP = parsed?.ok ? parsed.paisa : 0;
  const amountError = parsed && !parsed.ok ? parsed.message : parsed?.ok && parsed.paisa === 0 ? "Enter an amount greater than zero." : null;

  const docs: OutstandingDocument[] = useMemo(() => (outstanding.data ?? []).filter((d) => d.outstandingP > 0), [outstanding.data]);
  const auto = useMemo(() => autoAllocate(docs, amountP), [docs, amountP]);
  const manual = useMemo(() => manualAllocation(docs, entries, amountP), [docs, entries, amountP]);
  const autoById = useMemo(() => new Map(auto.lines.map((l) => [l.invoiceId, l.amountP])), [auto]);

  const manualNeedsLines = mode === "receive" && allocMode === "manual" && manual.lines.length === 0;
  const canSave =
    party !== null && amountP > 0 && !amountError && (mode !== "receive" || allocMode === "auto" || (!hasManualProblems(manual) && !manualNeedsLines));

  const mutation = useMutation<PaymentVoucher, unknown>({
    mutationFn: () => {
      const common = {
        amountP,
        date,
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        idempotencyKey: keyRef.current,
      };
      if (mode === "receive") {
        return receivePayment({ customerId: party!.id, ...common, ...(allocMode === "manual" ? { allocations: manual.lines } : {}) });
      }
      if (mode === "pay") return payPayment({ supplierId: party!.id, ...common });
      return refundPayment({ customerId: party!.id, ...common });
    },
    onSuccess: async (voucher) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.payments }),
        qc.invalidateQueries({ queryKey: ["balance"] }),
        qc.invalidateQueries({ queryKey: ["outstanding"] }),
        qc.invalidateQueries({ queryKey: ["statement"] }),
      ]);
      toast(`${voucher.receiptNumber} recorded — ${fmtMoney(voucher.amountP)}`);
      onClose();
      await navigate({ to: "/payments/$id/receipt", params: { id: voucher.id } });
    },
    onSettled: () => {
      busy.current = false;
    },
  });

  function save() {
    setSubmitted(true);
    setAmountTouched(true);
    if (!canSave || busy.current || mutation.isPending) return;
    busy.current = true; // double-click safe even before React re-renders the disabled button
    mutation.mutate();
  }

  const shownAmountError = amountTouched || submitted ? amountError : null;
  const balanceKind = copy.type === "customer" ? "CUSTOMER" : "SUPPLIER";
  const afterRefund = mode === "refund" && balance.data && amountP > 0 ? balance.data.balanceP + amountP : null;

  return (
    <Dialog open onClose={onClose} title={copy.title} description={copy.subtitle} wide={mode === "receive"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="space-y-4"
        noValidate
      >
        {copy.type === "customer" ? (
          <Field label="Area">
            <select
              value={area}
              onChange={(e) => {
                setArea(e.target.value);
                setParty(null);
              }}
              className={inputClass}
            >
              <option value="">All areas</option>
              {(regions.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nameEn}
                  {r.nameUr ? ` — ${r.nameUr}` : ""}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label={copy.partyLabel} error={submitted && !party ? `Choose a ${copy.noun}.` : null}>
          <PartyCombobox type={copy.type} value={party} onChange={setParty} regionId={area} label={copy.partyLabel} invalid={submitted && !party} />
        </Field>

        {party ? (
          <Banner tone="info" data-testid="party-balance">
            {balance.isPending ? "Loading balance…" : balance.isError ? "Couldn’t load the balance." : <span><b>Current balance:</b> {balanceWords(balanceKind, balance.data.balanceP)}</span>}
          </Banner>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={copy.amountLabel} error={shownAmountError}>
            <input
              inputMode="decimal"
              autoComplete="off"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              onBlur={() => setAmountTouched(true)}
              placeholder="e.g. 100,000"
              aria-invalid={shownAmountError ? true : undefined}
              className={inputClass}
            />
          </Field>
          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Reference">
            <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="Cheque / transaction no" className={inputClass} />
          </Field>
        </div>
        <Field label="Note">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Optional" className={inputClass} />
        </Field>

        {afterRefund !== null ? (
          <Banner tone="warn" data-testid="refund-confirmation">
            After this voucher: <b>{balanceWords("CUSTOMER", afterRefund)}</b>.
          </Banner>
        ) : null}

        {mode === "receive" && party ? (
          <AllocationSection
            loading={outstanding.isPending}
            error={outstanding.error}
            docs={docs}
            amountP={amountP}
            allocMode={allocMode}
            setAllocMode={setAllocMode}
            autoById={autoById}
            leftOverAuto={auto.leftOverP}
            entries={entries}
            setEntries={setEntries}
            manual={manual}
            needsLines={manualNeedsLines && submitted}
          />
        ) : null}

        {mutation.isError ? <ErrorLines error={mutation.error} onRetry={save} /> : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-(--color-border) pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? "Saving…" : copy.cta}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AllocationSection({
  loading,
  error,
  docs,
  amountP,
  allocMode,
  setAllocMode,
  autoById,
  leftOverAuto,
  entries,
  setEntries,
  manual,
  needsLines,
}: {
  loading: boolean;
  error: unknown;
  docs: OutstandingDocument[];
  amountP: number;
  allocMode: "auto" | "manual";
  setAllocMode: (m: "auto" | "manual") => void;
  autoById: Map<string, number>;
  leftOverAuto: number;
  entries: Record<string, string>;
  setEntries: (e: Record<string, string>) => void;
  manual: ReturnType<typeof manualAllocation>;
  needsLines: boolean;
}) {
  if (loading) return <Loading label="Loading unpaid invoices…" />;
  if (error) return <ErrorLines error={error} />;
  if (docs.length === 0) {
    return <Banner tone="info" data-testid="no-outstanding">This shop has no unpaid invoices. The whole amount will be kept on account.</Banner>;
  }
  const leftOver = allocMode === "auto" ? leftOverAuto : manual.leftOverP;
  const enteredTotal = manual.totalP;
  return (
    <section aria-label="Apply to invoices" className="space-y-2" data-testid="allocation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-(--color-text)">Apply to invoices</h3>
        <div role="radiogroup" aria-label="How to apply the payment" className="inline-flex overflow-hidden rounded-md border border-(--color-border) text-sm">
          {(
            [
              ["auto", "Oldest unpaid first"],
              ["manual", "Choose amounts"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={`cursor-pointer px-3 py-1.5 ${allocMode === value ? "bg-(--color-primary) text-(--color-primary-fg)" : "bg-(--color-surface) text-(--color-text)"}`}>
              <input type="radio" name="alloc-mode" value={value} checked={allocMode === value} onChange={() => setAllocMode(value)} className="sr-only" />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-(--color-border)">
        <table className="w-full text-sm">
          <thead className="bg-(--color-bg) text-left text-xs text-(--color-text-muted)">
            <tr>
              <th className="px-2 py-1.5 font-medium">Invoice</th>
              <th className="px-2 py-1.5 font-medium">Date</th>
              <th className="num px-2 py-1.5 font-medium">Outstanding</th>
              <th className="num px-2 py-1.5 font-medium">{allocMode === "auto" ? "This payment applies" : "Apply"}</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => {
              const applied = autoById.get(d.id) ?? 0;
              const rowError = manual.rowErrors[d.id];
              return (
                <tr key={d.id} className="border-t border-(--color-border)" data-testid="alloc-row" data-invoice={d.number ?? ""}>
                  <td className="px-2 py-1.5 font-mono text-xs">{d.number ?? "(draft)"}</td>
                  <td className="px-2 py-1.5">{fmtDate(d.date)}</td>
                  <td className="num px-2 py-1.5">{formatPaisaPlain(d.outstandingP)}</td>
                  <td className="num px-2 py-1.5">
                    {allocMode === "auto" ? (
                      <span data-testid="alloc-preview">{applied > 0 ? formatPaisaPlain(applied) : "—"}</span>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <input
                          inputMode="decimal"
                          aria-label={`Amount to apply to ${d.number ?? "draft invoice"}`}
                          aria-invalid={rowError ? true : undefined}
                          value={entries[d.id] ?? ""}
                          onChange={(e) => setEntries({ ...entries, [d.id]: e.target.value })}
                          className={`${inputClass} num w-28 py-1`}
                        />
                        <Button
                          size="sm"
                          aria-label={`Fill ${d.number ?? "draft invoice"}`}
                          onClick={() => {
                            const elsewhere = manual.totalP - (manual.lines.find((l) => l.invoiceId === d.id)?.amountP ?? 0);
                            const fill = fillAmount(d, amountP, elsewhere);
                            setEntries({ ...entries, [d.id]: fill > 0 ? formatPaisa(fill).replace(/,/g, "") : "" });
                          }}
                        >
                          Fill
                        </Button>
                      </div>
                    )}
                    {rowError ? (
                      <p role="alert" className="mt-0.5 text-right text-xs text-(--color-danger)">
                        {rowError}
                      </p>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {manual.totalError ? (
        <p role="alert" className="text-sm text-(--color-danger)">
          {manual.totalError}
        </p>
      ) : null}
      {needsLines ? (
        <p role="alert" className="text-sm text-(--color-danger)">
          Enter an amount against at least one invoice, or switch back to “Oldest unpaid first”.
        </p>
      ) : null}
      <p className="text-sm text-(--color-text-muted)" data-testid="alloc-summary">
        {allocMode === "manual" ? <>Applied to invoices: <b className="num">{formatPaisaPlain(enteredTotal)}</b> · </> : null}
        Left over → on account: <b className="num" data-testid="left-over">{formatPaisaPlain(leftOver)}</b>
      </p>
    </section>
  );
}
