import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatPaisaPlain, parseRupees, type PaymentDetail, type PaymentVoucher } from "@farooq/shared";
import { editPaymentAmount, keys, reversePayment } from "../lib/queries";
import { fmtMoney } from "../lib/format";
import { Banner, Button, Dialog, ErrorLines, Field, inputClass, useToast } from "./ui";

/** What reversing does, in the words of the party it touches — shown BEFORE the person confirms. */
export function reverseEffect(p: Pick<PaymentDetail, "kind" | "amountP" | "allocations">): string[] {
  const amount = fmtMoney(p.amountP);
  const lines: string[] = [];
  if (p.kind === "received") {
    lines.push(`The shop’s balance goes up by ${amount} — the shop owes us that amount again, and the statement no longer shows this receipt.`);
    if (p.allocations.length > 0) lines.push("The invoices this receipt was applied to become unpaid again by the amounts applied.");
  } else if (p.kind === "paidToShops") {
    lines.push(`The shop’s balance goes down by ${amount} — the money we paid out is taken back off the shop’s account, and the statement no longer shows this voucher.`);
  } else {
    lines.push(`We owe the supplier ${amount} more — the statement no longer shows this voucher.`);
    if (p.allocations.length > 0) lines.push("The purchases this voucher was applied to become unpaid again by the amounts applied.");
  }
  lines.push("The voucher stays on file, marked Reversed, with your reason. It cannot be reversed again.");
  return lines;
}

function useAfterCorrection() {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.payments }),
      qc.invalidateQueries({ queryKey: ["balance"] }),
      qc.invalidateQueries({ queryKey: ["outstanding"] }),
      qc.invalidateQueries({ queryKey: ["statement"] }),
    ]);
  };
}

export function ReverseDialog({ payment, onClose }: { payment: PaymentDetail; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const after = useAfterCorrection();
  const toast = useToast();
  const busy = useRef(false);

  const mutation = useMutation<PaymentVoucher, unknown>({
    mutationFn: () => reversePayment(payment.id, { reason: reason.trim() }),
    onSuccess: async () => {
      await after();
      toast(`${payment.receiptNumber} reversed`);
      onClose();
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
    <Dialog open onClose={onClose} title={`Reverse ${payment.receiptNumber}`} description={`${fmtMoney(payment.amountP)} · ${payment.partyNameSnapshot ?? payment.partyName ?? ""}`}>
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
            {reverseEffect(payment).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Banner>
        <Field label="Reason" error={touched && reasonMissing ? "Enter a reason." : null}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. entered against the wrong shop" dir="auto" className={inputClass} />
        </Field>
        {mutation.isError ? <ErrorLines error={mutation.error} onRetry={confirm} /> : null}
        <div className="flex justify-end gap-2 border-t border-(--color-border) pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={reasonMissing || mutation.isPending}>
            {mutation.isPending ? "Reversing…" : "Reverse voucher"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function EditAmountDialog({ payment, onClose }: { payment: PaymentDetail; onClose: () => void }) {
  const [amountText, setAmountText] = useState(formatPaisaPlain(payment.amountP).replace(/,/g, ""));
  const [reason, setReason] = useState("");
  const after = useAfterCorrection();
  const toast = useToast();
  const busy = useRef(false);

  const refusal = payment.actions.editAmount.allowed ? null : (payment.actions.editAmount.reason ?? "This voucher’s amount cannot be changed.");
  const parsed = parseRupees(amountText);
  const newP = parsed.ok ? parsed.paisa : null;
  const amountError = !parsed.ok ? parsed.message : parsed.paisa <= 0 ? "Enter an amount greater than zero." : null;
  const unchanged = newP === payment.amountP;

  const mutation = useMutation<PaymentVoucher, unknown>({
    mutationFn: () => editPaymentAmount(payment.id, { amountP: newP!, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: async () => {
      await after();
      toast(`${payment.receiptNumber} amount changed to ${fmtMoney(newP!)}`);
      onClose();
    },
    onSettled: () => {
      busy.current = false;
    },
  });

  function save() {
    if (amountError || unchanged || busy.current || mutation.isPending) return;
    busy.current = true;
    mutation.mutate();
  }

  return (
    <Dialog open onClose={onClose} title={`Correct the amount of ${payment.receiptNumber}`} description="The date, method and reference stay exactly as they are.">
      {refusal ? (
        <div className="space-y-4">
          <Banner tone="warn" title="This voucher’s amount cannot be corrected here" data-testid="edit-refusal">
            <p>{refusal}</p>
          </Banner>
          <div className="flex justify-end border-t border-(--color-border) pt-4">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <p className="text-sm text-(--color-text-muted)">
            Current amount: <b className="num text-(--color-text)">{fmtMoney(payment.amountP)}</b>
          </p>
          <Field label="Correct amount" error={amountError}>
            <input inputMode="decimal" autoComplete="off" value={amountText} onChange={(e) => setAmountText(e.target.value)} className={inputClass} />
          </Field>
          {newP !== null && !amountError && !unchanged ? (
            <p className="text-sm text-(--color-text-muted)" data-testid="edit-effect">
              The amount will {newP > payment.amountP ? "rise" : "fall"} by <b className="num">{fmtMoney(Math.abs(newP - payment.amountP))}</b>.
            </p>
          ) : null}
          <Field label="Reason">
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. wrong amount typed" dir="auto" className={inputClass} />
          </Field>
          {mutation.isError ? <ErrorLines error={mutation.error} onRetry={save} /> : null}
          <div className="flex justify-end gap-2 border-t border-(--color-border) pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={Boolean(amountError) || unchanged || mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save new amount"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
