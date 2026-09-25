import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { RequirePurchasesAccess } from "../components/guard";
import { PurchasePaper } from "../components/purchase-paper";
import { Banner, Button, ErrorLines, Loading } from "../components/ui";
import { ApiError } from "../lib/api";
import { getPurchasePrint, keys } from "../lib/queries";
import "../invoice-paper.css";

export function PurchasePrintPage() {
  return (
    <RequirePurchasesAccess>
      <PurchasePrintScreen />
    </RequirePurchasesAccess>
  );
}

function PurchasePrintScreen() {
  const { id } = useParams({ from: "/shell/purchases/$id/print" });
  const q = useQuery({ queryKey: keys.purchasePrint(id), queryFn: () => getPurchasePrint(id), retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2 });

  if (q.isPending) return <Loading label="Loading purchase…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <Link to="/purchases" className="text-sm text-(--color-primary) hover:underline">
          ← All purchases
        </Link>
        {notFound ? <Banner tone="warn" title="Purchase not found">This purchase does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  const m = q.data;
  return (
    <div className="mx-auto max-w-[210mm] space-y-3">
      <div className="no-print flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link to="/purchases/$id" params={{ id: m.purchaseId }} className="text-sm text-(--color-primary) hover:underline">
          ← Back to purchase
        </Link>
        <Button variant="primary" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <div className="fcdoc-wrap rounded-md border border-[#ccc] bg-white shadow-sm print:border-0 print:shadow-none">
        <PurchasePaper m={m} />
      </div>
    </div>
  );
}
