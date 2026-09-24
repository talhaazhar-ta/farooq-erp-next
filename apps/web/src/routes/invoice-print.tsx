import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { INVOICE_TEMPLATES } from "@farooq/shared";
import { RequireInvoicesAccess } from "../components/guard";
import { InvoicePaper } from "../components/invoice-paper";
import { Banner, Button, ErrorLines, Loading, cn } from "../components/ui";
import { ApiError } from "../lib/api";
import { getInvoicePrint, keys } from "../lib/queries";
import "../invoice-paper.css";

/** `?template=classic|standard`; anything else means "the business's own setting" (the server picks). */
export const templateFromSearch = (raw: Record<string, unknown>): Record<string, string> => {
  const t = String(raw.template ?? "");
  return (INVOICE_TEMPLATES as readonly string[]).includes(t) ? { template: t } : {};
};

const LAYOUT_LABELS: Record<(typeof INVOICE_TEMPLATES)[number], string> = { classic: "Classic layout", standard: "Standard layout" };

export function InvoicePrintPage() {
  return (
    <RequireInvoicesAccess>
      <InvoicePrintScreen />
    </RequireInvoicesAccess>
  );
}

function InvoicePrintScreen() {
  const { id } = useParams({ from: "/shell/invoices/$id/print" });
  const search = useSearch({ from: "/shell/invoices/$id/print" });
  // the address is re-read here (as every screen does): whatever it says, only a real layout name is ever sent to the server
  const asked = templateFromSearch(search).template ?? "";
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: keys.invoicePrint(id, asked),
    queryFn: () => getInvoicePrint(id, asked),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });

  if (q.isPending) return <Loading label="Loading invoice…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <Link to="/invoices" className="text-sm text-(--color-primary) hover:underline">
          ← All invoices
        </Link>
        {notFound ? <Banner tone="warn" title="Invoice not found">This invoice does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  const m = q.data;

  return (
    <div className="mx-auto max-w-[210mm] space-y-3">
      <div className="no-print flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link to="/invoices/$id" params={{ id: m.invoiceId }} className="text-sm text-(--color-primary) hover:underline">
          ← Back to invoice
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Layout" className="inline-flex overflow-hidden rounded-md border border-(--color-border) text-sm">
            {INVOICE_TEMPLATES.map((t) => (
              <label key={t} className={cn("cursor-pointer px-3 py-2", m.template === t ? "bg-(--color-primary) text-(--color-primary-fg)" : "bg-(--color-surface) text-(--color-text)")}>
                <input
                  type="radio"
                  name="layout"
                  value={t}
                  checked={m.template === t}
                  onChange={() => void navigate({ to: "/invoices/$id/print", params: { id }, search: { template: t }, replace: true })}
                  className="sr-only"
                />
                {LAYOUT_LABELS[t]}
              </label>
            ))}
          </div>
          <Button variant="primary" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      <div className="fcdoc-wrap rounded-md border border-[#ccc] bg-white shadow-sm print:border-0 print:shadow-none">
        <InvoicePaper m={m} />
      </div>
    </div>
  );
}
