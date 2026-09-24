import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { SignInPage } from "./routes/sign-in";
import { AuthenticatedShell } from "./routes/shell";
import { DashboardPage } from "./routes/dashboard";
import { PaymentsPage } from "./routes/payments";
import { PaymentDetailPage } from "./routes/payment-detail";
import { ReceiptPage } from "./routes/receipt";
import { StatementsPage } from "./routes/statements";
import { InvoicesPage } from "./routes/invoices";
import { InvoiceDetailPage } from "./routes/invoice-detail";
import { InvoicePrintPage, templateFromSearch } from "./routes/invoice-print";
import { invoiceFiltersFromSearch, invoiceFiltersToSearch } from "./lib/invoice-filters";
import { filtersFromSearch, filtersToSearch } from "./lib/payment-filters";
import { statementSearchFrom, statementSearchOut } from "./lib/statement-filters";

const rootRoute = createRootRoute();

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignInPage,
});

// Everything behind the sign-in lives under one layout route (nav, header, session check).
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AuthenticatedShell,
});

const indexRoute = createRoute({ getParentRoute: () => shellRoute, path: "/", component: DashboardPage });

const paymentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/payments",
  // the address is kept as a clean, string-only record; each screen reads it back with its own parser
  validateSearch: (raw: Record<string, unknown>): Record<string, string> => filtersToSearch(filtersFromSearch(raw)),
  component: PaymentsPage,
});

const paymentDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/payments/$id",
  component: PaymentDetailPage,
});

const receiptRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/payments/$id/receipt",
  component: ReceiptPage,
});

const invoicesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invoices",
  validateSearch: (raw: Record<string, unknown>): Record<string, string> => invoiceFiltersToSearch(invoiceFiltersFromSearch(raw)),
  component: InvoicesPage,
});

const invoiceDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invoices/$id",
  component: InvoiceDetailPage,
});

const invoicePrintRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invoices/$id/print",
  validateSearch: (raw: Record<string, unknown>): { template?: string } => templateFromSearch(raw),
  component: InvoicePrintPage,
});

const statementsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/statements",
  validateSearch: (raw: Record<string, unknown>): Record<string, string> => statementSearchOut(statementSearchFrom(raw)),
  component: StatementsPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  shellRoute.addChildren([indexRoute, paymentsRoute, paymentDetailRoute, receiptRoute, invoicesRoute, invoiceDetailRoute, invoicePrintRoute, statementsRoute]),
]);

/**
 * Addresses are plain `?a=1&b=2` (the router's default would JSON-encode values, turning a search for `123` into a
 * number). Every screen's state is a flat set of strings, parsed and validated by its own `validateSearch`.
 */
export const router = createRouter({
  routeTree,
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) if (v !== undefined && v !== null && String(v) !== "") usp.set(k, String(v));
    const s = usp.toString();
    return s ? `?${s}` : "";
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
