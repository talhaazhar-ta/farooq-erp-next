import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Role } from "@farooq/shared";
import { mockApi } from "../test/fetch-mock";
import { IDS, invoiceDetail, PROFIT } from "../test/invoice-fixtures";

let role: Role = "OWNER";
let searchState: Record<string, string> = {};
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", name: "Tester", username: "t", role }, isLoading: false }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }),
  useSearch: () => searchState,
  Link: ({ children, to, params, search, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string> } & Record<string, unknown>) => (
    <a href={to.replace("$id", params?.id ?? "") + (search ? `?${new URLSearchParams(search)}` : "")} {...rest}>
      {children}
    </a>
  ),
}));

import { InvoiceDetailPage } from "./invoice-detail";
import { InvoicesPage, KpiCards } from "./invoices";
import { ToastProvider } from "../components/ui";

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = "OWNER";
  searchState = {};
});

describe("the four cards come from the server's kpis (nothing re-added on the screen)", () => {
  it("draws count, invoiced, received, outstanding and the drafts on file", () => {
    render(<KpiCards kpis={{ count: 6, drafts: 1, invoicedP: 3_550_000, receivedP: 950_000, outstandingP: 2_460_000 }} />);
    expect(screen.getByTestId("kpi-count")).toHaveTextContent("6");
    expect(screen.getByTestId("kpi-count-note")).toHaveTextContent("1 draft on file");
    expect(screen.getByTestId("kpi-invoiced")).toHaveTextContent("35,500.00");
    expect(screen.getByTestId("kpi-received")).toHaveTextContent("9,500.00");
    expect(screen.getByTestId("kpi-outstanding")).toHaveTextContent("24,600.00");
  });
  it("says 'drafts' for more than one", () => {
    render(<KpiCards kpis={{ count: 0, drafts: 3, invoicedP: 0, receivedP: 0, outstandingP: 0 }} />);
    expect(screen.getByTestId("kpi-count-note")).toHaveTextContent("3 drafts on file");
  });
});

const listItem = (patch: Record<string, unknown> = {}) => ({
  id: IDS.invoice, number: "INV-2026-000031", orderNumber: "ORD-2026-000004", date: "2026-09-01", status: "PARTIALLY_PAID", paymentStatus: "PARTIAL", customerId: IDS.shop,
  shopName: "Alpha Store", ownerName: "Noor", region: "Drosh", warehouse: "Main Godown", itemCount: 2, quantity: 30, subtotalP: 2_742_500, discountP: 0, chargesP: 0,
  totalP: 2_742_500, paidP: 400_000, outstandingP: 2_342_500,
  hits: { lines: [{ name: "Taj Mahal Sella", quantity: 20 }], more: 1, pays: ["REC-2026-000031 (4471)"], morePays: 0 },
  ...patch,
});
const emptyFacets = Object.fromEntries(["DRAFT", "CONFIRMED", "DISPATCHED", "PARTIALLY_PAID", "PAID", "CANCELLED", "RETURNED", "PARTIALLY_RETURNED"].map((s) => [s, { count: s === "PARTIALLY_PAID" ? 1 : 0, totalP: 0 }]));
const listResponse = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items, total: items.length, limit: 50, offset: 0, onFile: 9,
  interpreted: { terms: [], dates: [], dateFilterReplaced: false, problems: [] },
  kpis: { count: 1, drafts: 2, invoicedP: 2_742_500, receivedP: 400_000, outstandingP: 2_342_500 },
  statusFacets: emptyFacets, ...extra,
});
const listRoutes = (response: unknown) => ({ "GET /invoices": response, "GET /regions": [], "GET /warehouses": [] });

describe("the list", () => {
  it("draws a row with its number, order number, shop, status and the 'why it matched' line", async () => {
    mockApi(listRoutes(listResponse([listItem(), listItem({ id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", number: null, orderNumber: null, status: "DRAFT", paymentStatus: "UNPAID", hits: null })])));
    wrap(<InvoicesPage />);
    const rows = await screen.findAllByTestId("invoice-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "INV-2026-000031" })).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Order ORD-2026-000004")).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId("row-hits")).toHaveTextContent("Taj Mahal Sella × 20 · +1 more · Paid by REC-2026-000031 (4471)");
    expect(within(rows[0]!).getByText("Partly paid", { selector: "span.rounded-full" })).toBeInTheDocument();
    // a draft has no number: it says so
    expect(within(rows[1]!).getByRole("link", { name: "Draft" })).toBeInTheDocument();
    expect(within(rows[1]!).queryByTestId("row-hits")).toBeNull();
    expect(screen.getByTestId("count-line")).toHaveTextContent("9 invoices on file");
    expect(screen.getByTestId("kpi-count-note")).toHaveTextContent("2 drafts on file");
  });

  it("a row links to the shop's statement, the invoice and its print", async () => {
    mockApi(listRoutes(listResponse([listItem()])));
    wrap(<InvoicesPage />);
    const row = (await screen.findAllByTestId("invoice-row"))[0]!;
    expect(within(row).getByRole("link", { name: "Open" })).toHaveAttribute("href", `/invoices/${IDS.invoice}`);
    expect(within(row).getByRole("link", { name: "Print" })).toHaveAttribute("href", `/invoices/${IDS.invoice}/print`);
    expect(within(row).getByRole("link", { name: "Statement" }).getAttribute("href")).toContain(`partyId=${IDS.shop}`);
  });

  it("the status picker carries the server's counts", async () => {
    mockApi(listRoutes(listResponse([listItem()])));
    wrap(<InvoicesPage />);
    await screen.findAllByTestId("invoice-row");
    expect(screen.getByRole("option", { name: "Partly paid (1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Paid (0)" })).toBeInTheDocument();
  });

  it("says how the box was read, and shows a problem as a warning (an empty list on purpose)", async () => {
    searchState = { q: "12/09/2026" };
    mockApi(
      listRoutes(
        listResponse([], {
          total: 0,
          interpreted: {
            terms: [],
            dates: [{ label: "12 Sep 2026", from: "2026-09-12", to: "2026-09-12", src: "12/09/2026", dayFirst: true }],
            dateFilterReplaced: true,
            problems: ["The “From” date is after the “To” date, so no invoice can match."],
          },
        }),
      ),
    );
    wrap(<InvoicesPage />);
    expect(await screen.findByTestId("search-read-as")).toHaveTextContent("“12/09/2026” is read as 12 Sep 2026 (day / month / year) — this replaces the date filter.");
    expect(screen.getByTestId("search-problem")).toHaveTextContent("The “From” date is after the “To” date");
    expect(screen.getByText("No invoices match")).toBeInTheDocument();
    expect(screen.getByTestId("count-line")).toHaveTextContent("0 of 9 invoices match");
  });

  it("the warehouse role gets 'Not available for the Warehouse role', not a list", () => {
    role = "INVENTORY";
    mockApi({});
    wrap(<InvoicesPage />);
    expect(screen.getByTestId("not-available")).toHaveTextContent("Not available for the Warehouse role");
  });
});

describe("the view page: what each role is offered", () => {
  const detailRoutes = (d: unknown) => ({ [`GET /invoices/${IDS.invoice}`]: d, "GET /warehouses": [{ id: IDS.warehouse, name: "Main Godown", active: true }] });

  it("the profit block is in the page for a role that has it — 'cost unknown' on a line without a cost, never 0", async () => {
    mockApi(detailRoutes({ ...invoiceDetail(), profit: PROFIT }));
    wrap(<InvoiceDetailPage />);
    expect(await screen.findByTestId("profit-block")).toBeInTheDocument();
    expect(screen.getByTestId("profit-total")).toHaveTextContent("PKR 3,000.00");
    expect(screen.getByTestId("profit-incomplete")).toHaveTextContent("Cost unknown on 1 line");
    const cells = screen.getAllByTestId("line-profit").map((c) => c.textContent);
    expect(cells.some((t) => t === "cost unknown")).toBe(true);
    expect(cells.some((t) => /PKR 3,000\.00/.test(t ?? ""))).toBe(true);
  });

  it("the profit KEY is absent for a role without PROFIT_VIEW: the DOM has no profit block, no profit column, no cost words", async () => {
    role = "SALES";
    const d = invoiceDetail();
    expect("profit" in d).toBe(false);
    mockApi(detailRoutes(d));
    const { container } = wrap(<InvoiceDetailPage />);
    await screen.findByTestId("invoice-number");
    expect(screen.queryByTestId("profit-block")).toBeNull();
    expect(screen.queryAllByTestId("line-profit")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/profit|margin|cost unknown/i);
    expect(screen.queryByRole("columnheader", { name: "Profit" })).toBeNull();
  });

  it("OWNER sees Cancel invoice and Change shop on a posted invoice; a draft offers Discard, Duplicate and Print only — nothing about editing", async () => {
    mockApi(detailRoutes(invoiceDetail()));
    const { unmount } = wrap(<InvoiceDetailPage />);
    expect(await screen.findByTestId("action-cancel")).toHaveTextContent("Cancel invoice");
    expect(screen.getByTestId("action-change-shop")).toBeEnabled();
    expect(screen.queryByText(/^Edit/)).toBeNull();
    unmount();

    mockApi(detailRoutes(invoiceDetail({ status: "DRAFT", number: null, stockApplied: false, stockMovements: [] })));
    const draft = wrap(<InvoiceDetailPage />);
    expect(await screen.findByTestId("action-cancel")).toHaveTextContent("Discard draft");
    expect(screen.queryByTestId("action-change-shop")).toBeNull();
    expect(screen.getByRole("link", { name: "Print" })).toBeInTheDocument();
    expect(screen.getByTestId("action-duplicate")).toBeInTheDocument();
    expect(draft.container.textContent).not.toMatch(/\bedit\b/i);
    expect(screen.getByTestId("invoice-number")).toHaveTextContent("Draft");
  });

  it("SALES may discard a draft but is not even offered Cancel invoice or Change shop on a posted one", async () => {
    role = "SALES";
    mockApi(detailRoutes(invoiceDetail({ status: "DRAFT", number: null, stockApplied: false, stockMovements: [] })));
    const { unmount } = wrap(<InvoiceDetailPage />);
    expect(await screen.findByTestId("action-cancel")).toHaveTextContent("Discard draft");
    expect(screen.getByTestId("action-cancel")).toBeEnabled();
    unmount();

    mockApi(detailRoutes(invoiceDetail({ actions: { ...invoiceDetail().actions, cancel: { allowed: false, reason: "You do not have permission to edit a posted invoice, cancel it or change its shop." } } })));
    wrap(<InvoiceDetailPage />);
    await screen.findByTestId("invoice-number");
    expect(screen.queryByTestId("action-cancel")).toBeNull();
    expect(screen.queryByTestId("action-change-shop")).toBeNull();
  });

  it("a refused action is drawn disabled with the SERVER's reason (never re-derived), and receipts are listed with links when money blocks a cancel", async () => {
    const reason = "Money has been received against this invoice (REC-2026-000031 — PKR 4,000.00). Reverse the receipt first, then cancel the invoice.";
    mockApi(
      detailRoutes(
        invoiceDetail({
          status: "PARTIALLY_PAID",
          paymentStatus: "PARTIAL",
          paidP: 400_000,
          receipts: [{ paymentId: IDS.receipt, receiptNumber: "REC-2026-000031", date: "2026-09-02", method: "Cash", reference: null, allocatedP: 400_000, status: "POSTED" }],
          actions: { edit: { allowed: true, reason: null }, cancel: { allowed: false, reason }, changeShop: { allowed: true, reason: null }, duplicate: { allowed: true, reason: null } },
        }),
      ),
    );
    wrap(<InvoiceDetailPage />);
    const btn = await screen.findByTestId("action-cancel");
    expect(btn).toBeDisabled();
    expect(screen.getByTestId("reason-cancel")).toHaveTextContent(reason);
    const links = screen.getByTestId("receipt-links");
    expect(within(links).getByRole("link", { name: "REC-2026-000031" })).toHaveAttribute("href", `/payments/${IDS.receipt}`);
  });

  it("a cancelled invoice says so, with the reason, and its Cancel button is off with the server's words", async () => {
    mockApi(
      detailRoutes(
        invoiceDetail({
          status: "CANCELLED",
          cancelledAt: "2026-09-03T05:00:00.000Z",
          cancelReason: "customer changed his mind",
          actions: { edit: { allowed: false, reason: "x" }, cancel: { allowed: false, reason: "This invoice is already cancelled." }, changeShop: { allowed: false, reason: "A cancelled invoice cannot be moved to another shop." }, duplicate: { allowed: true, reason: null } },
        }),
      ),
    );
    wrap(<InvoiceDetailPage />);
    expect(await screen.findByTestId("cancelled-banner")).toHaveTextContent("customer changed his mind");
    expect(screen.getByTestId("reason-cancel")).toHaveTextContent("This invoice is already cancelled.");
    expect(screen.getByTestId("reason-change-shop")).toHaveTextContent("A cancelled invoice cannot be moved to another shop.");
  });

  it("totals: the grand total and the balance are the server's figures; a zero charge row is not drawn", async () => {
    mockApi(detailRoutes(invoiceDetail({ freightP: 50_000, totalP: 2_792_500, paidP: 400_000, outstandingP: 2_392_500 })));
    wrap(<InvoiceDetailPage />);
    expect(await screen.findByTestId("grand-total")).toHaveTextContent("27,925.00");
    expect(screen.getByTestId("paid-total")).toHaveTextContent("4,000.00");
    expect(screen.getByTestId("balance-total")).toHaveTextContent("23,925.00");
    const totals = screen.getByTestId("totals");
    expect(totals).toHaveTextContent("Delivery / freight");
    expect(totals).not.toHaveTextContent("Loading / unloading");
    expect(totals).not.toHaveTextContent("Tax");
  });

  it("the stock effect names the product and the godown", async () => {
    mockApi(detailRoutes(invoiceDetail()));
    wrap(<InvoiceDetailPage />);
    const row = await screen.findByTestId("stock-row");
    expect(row).toHaveTextContent("Zam Zam Atta 20KG");
    expect(row).toHaveTextContent("Main Godown");
    expect(within(row).getByTestId("stock-qty")).toHaveTextContent("-20");
  });
});
