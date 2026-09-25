import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Role } from "@farooq/shared";
import { mockApi } from "../test/fetch-mock";

let role: Role = "OWNER";
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", name: "Tester", username: "t", role }, isLoading: false }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: PID }),
  useSearch: () => ({}),
  Link: ({ children, to, params, search, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string> } & Record<string, unknown>) => (
    <a href={to.replace("$id", params?.id ?? "") + (search ? `?${new URLSearchParams(search)}` : "")} {...rest}>
      {children}
    </a>
  ),
}));

import { PurchaseDetailPage } from "./purchase-detail";
import { PurchaseKpis, PurchasesPage } from "./purchases";
import { ToastProvider } from "../components/ui";

const PID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SUP = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const WH = "cccccccc-1111-4111-8111-cccccccccccc";
const PR = "dddddddd-1111-4111-8111-dddddddddddd";
const PV = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";

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
});

const item = (patch: Record<string, unknown> = {}) => ({
  id: PID, number: "PUR-2026-000007", date: "2026-09-20", status: "PARTIALLY_RECEIVED", paymentStatus: "PARTIAL", supplierId: SUP,
  supplierName: "Zam zam zinko flour mill", supplierCurrentName: "Zam Zam Mills", supplierInvoiceNo: "SB-5", warehouse: "College Warehouse",
  firstLine: { name: "Zam Zam", nameUr: "زم زم", package: "40 KG", unitPriceP: 590_000 }, lineCount: 2, orderedQuantity: 200, receivedQuantity: 150,
  totalP: 89_000_000, paidP: 10_000_000, balanceP: 79_000_000, hits: { lines: [{ name: "Sunrise Fine", quantity: 100 }], more: 0 },
  ...patch,
});
const facets = { PAID: { count: 0, totalP: 0 }, UNPAID: { count: 2, totalP: 5 }, PARTIAL: { count: 1, totalP: 89_000_000 } };
const listResponse = (items: unknown[]) => ({
  items, total: items.length, limit: 50, offset: 0, onFile: 5, categories: ["آٹا", "چاول"],
  interpreted: { terms: [], dates: [], dateFilterReplaced: false, problems: [] },
  kpis: { count: 3, receivedQuantity: 1310, orderedQuantity: 1360, valueP: 120_000_000, owedP: 60_000_000, suppliers: 2, suppliersOwed: 1 },
  payFacets: facets,
});

describe("the cards (fix 4: bags RECEIVED; ordered said apart)", () => {
  it("draws the server's figures and words", () => {
    render(<PurchaseKpis kpis={{ count: 3, receivedQuantity: 1310, orderedQuantity: 1360, valueP: 120_000_000, owedP: 60_000_000, suppliers: 2, suppliersOwed: 1 }} />);
    expect(screen.getByText("Bags received")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-bags")).toHaveTextContent("1,310");
    expect(screen.getByTestId("kpi-bags-note")).toHaveTextContent("3 purchases · 1,360 ordered");
    expect(screen.getByTestId("kpi-value")).toHaveTextContent("1,200,000.00");
    expect(screen.getByTestId("kpi-value-note")).toHaveTextContent("Where a rate was entered");
    expect(screen.getByTestId("kpi-owed")).toHaveTextContent("600,000.00");
    expect(screen.getByTestId("kpi-owed-note")).toHaveTextContent("1 with a balance");
    expect(screen.getByTestId("kpi-suppliers")).toHaveTextContent("2");
  });
});

describe("the list", () => {
  it("a row: number, supplier as printed + now, first line, bags received OF ordered, balance, payment, why it matched, links", async () => {
    mockApi({ "GET /purchases": listResponse([item(), item({ id: "ffffffff-1111-4111-8111-ffffffffffff", status: "CANCELLED", hits: null, supplierCurrentName: null })]), "GET /warehouses": [] });
    wrap(<PurchasesPage />);
    const rows = await screen.findAllByTestId("purchase-row");
    const r = rows[0]!;
    expect(within(r).getByRole("link", { name: "PUR-2026-000007" })).toHaveAttribute("href", `/purchases/${PID}`);
    expect(within(r).getByText("Zam zam zinko flour mill")).toBeInTheDocument();
    expect(within(r).getByTestId("supplier-now")).toHaveTextContent("now Zam Zam Mills");
    expect(within(r).getByTestId("row-bags")).toHaveTextContent("150 of 200");
    expect(within(r).getByTestId("row-balance")).toHaveTextContent("790,000.00");
    expect(within(r).getByTestId("row-hits")).toHaveTextContent("Sunrise Fine × 100");
    expect(within(r).getByText("Partial")).toBeInTheDocument();
    expect(within(r).getByText("Partly received")).toBeInTheDocument();
    expect(within(r).getByRole("link", { name: "Statement" })).toHaveAttribute("href", `/statements?type=supplier&partyId=${SUP}`);
    expect(within(r).getByRole("link", { name: "Print" })).toHaveAttribute("href", `/purchases/${PID}/print`);
    // a cancelled purchase owes nothing
    expect(within(rows[1]!).getByTestId("row-balance")).toHaveTextContent("");
    expect(within(rows[1]!).getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByTestId("count-line")).toHaveTextContent("5 purchases on file");
    // the payment picker shows the server's counts; the category picker the categories on file
    expect(screen.getByRole("option", { name: "Unpaid (2)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "چاول" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search supplier, product or invoice…")).toBeInTheDocument();
  });

  it("the warehouse role and Sales get the not-available panel and no request is made", () => {
    for (const r of ["INVENTORY", "SALES"] as Role[]) {
      role = r;
      const { calls } = mockApi({});
      const { unmount } = wrap(<PurchasesPage />);
      expect(screen.getByText(/Not available for the/)).toBeInTheDocument();
      expect(calls).toEqual([]);
      unmount();
    }
  });
});

const detail = (patch: Record<string, unknown> = {}) => ({
  id: PID, number: "PUR-2026-000007", status: "PARTIALLY_RECEIVED", paymentStatus: "PARTIAL", date: "2026-09-20", supplierId: SUP,
  supplierName: "Zam zam zinko flour mill", supplierInvoiceNo: "SB-5", warehouseId: WH, warehouseName: "College Warehouse", vehicleNo: "103", driver: null, deliveryRef: null,
  subtotalP: 1_000_000, itemDiscountsP: 0, invoiceDiscountP: 0, discountAmountP: 0, taxP: 0, freightP: 50_000, loadingP: 0, otherChargesP: 0, totalP: 1_050_000,
  paidP: 300_000, balanceP: 750_000, notes: null, description: null, orderedQuantity: 10, receivedQuantity: 6, lineCount: 1, stockApplied: true, migrated: false,
  revision: 2, createdBy: null, createdAt: "2026-09-20T05:00:00.000Z", updatedAt: "2026-09-20T05:00:00.000Z",
  lines: [
    {
      id: "99999999-1111-4111-8111-999999999999", sortOrder: 0, productId: PR, warehouseId: WH, description: "زم زم", descriptionEn: "Zam Zam", brand: "Zam", package: "40 KG",
      unit: "Bag", quantity: 10, qtyMilli: 10_000, receivedQuantity: 6, receivedQtyMilli: 6_000, returnedQuantity: 1, unitPriceP: 100_000, discountP: 0, taxP: 0, lineTotalP: 1_000_000,
      batchNo: null, notes: null, goodsUnitCostP: 100_000, chargeShareP: 50_000, landedUnitCostP: 108_333, operationalShareP: null,
    },
  ],
  payments: [{ paymentId: PV, receiptNumber: "PV-2026-000009", date: "2026-09-21", method: "Cash", reference: "SB-5", allocatedP: 300_000, status: "POSTED" }],
  stockMovements: [],
  actions: { edit: { allowed: true, reason: null }, changeSupplier: { allowed: false, reason: "Money has already been paid against this purchase (PV-2026-000009), and it belongs to this supplier — so the supplier cannot be changed here. Reverse that payment voucher first." } },
  supplierCurrentName: "Zam Zam Mills",
  supplierBalanceP: 2_500_000,
  costs: { basis: "LANDED", stock: [{ productId: PR, warehouseId: WH, avgCostP: 104_000, lastCostP: 108_333 }] },
  ...patch,
});

describe("the view page", () => {
  it("lines with ordered / received / returned, totals, the voucher linked, the supplier now and its balance, the server's reasons", async () => {
    mockApi({ [`GET /purchases/${PID}`]: detail(), "GET /warehouses": [{ id: WH, name: "College Warehouse", active: true }] });
    wrap(<PurchaseDetailPage />);
    expect(await screen.findByTestId("purchase-number")).toHaveTextContent("PUR-2026-000007");
    expect(screen.getByTestId("line-ordered")).toHaveTextContent("10");
    expect(screen.getByTestId("line-received")).toHaveTextContent("6");
    expect(screen.getByTestId("line-returned")).toHaveTextContent("1");
    expect(screen.getByTestId("purchase-bags")).toHaveTextContent("6 received of 10 ordered");
    expect(screen.getByTestId("grand-total")).toHaveTextContent("10,500.00");
    expect(screen.getByTestId("balance-total")).toHaveTextContent("7,500.00");
    expect(screen.getByRole("link", { name: "PV-2026-000009" })).toHaveAttribute("href", `/payments/${PV}`);
    expect(screen.getByTestId("supplier-now")).toHaveTextContent("Now called Zam Zam Mills");
    expect(screen.getByTestId("supplier-balance")).toHaveTextContent("25,000");
    expect(screen.getByTestId("reason-change-supplier")).toHaveTextContent(/^Money has already been paid against this purchase \(PV-2026-000009\)/);
    expect(screen.getByTestId("action-change-supplier")).toBeDisabled();
    expect(screen.getByTestId("action-edit")).toHaveAttribute("data-allowed", "true");
    expect(screen.getByTestId("cost-block")).toHaveTextContent("average 1,040.00");
    expect(screen.getByTestId("line-cost")).toHaveTextContent("1,083.33");
  });

  it("without PROFIT_VIEW the cost keys are absent — and so is every trace of cost on the page", async () => {
    const d = detail() as Record<string, any>;
    delete d.costs;
    d.lines = d.lines.map(({ goodsUnitCostP: _g, chargeShareP: _c, landedUnitCostP: _l, operationalShareP: _o, ...l }: Record<string, unknown>) => l);
    role = "ACCOUNTANT";
    mockApi({ [`GET /purchases/${PID}`]: d, "GET /warehouses": [] });
    const { container } = wrap(<PurchaseDetailPage />);
    await screen.findByTestId("purchase-number");
    expect(screen.queryByTestId("cost-block")).toBeNull();
    expect(screen.queryByTestId("line-cost")).toBeNull();
    expect(container.textContent).not.toMatch(/landed|average/i);
  });

  it("an edit the server refuses shows its words; a cancelled purchase says so", async () => {
    mockApi({
      [`GET /purchases/${PID}`]: detail({ status: "CANCELLED", actions: { edit: { allowed: false, reason: "A cancelled purchase cannot be edited." }, changeSupplier: { allowed: false, reason: "A cancelled purchase cannot be edited." } } }),
      "GET /warehouses": [],
    });
    wrap(<PurchaseDetailPage />);
    expect(await screen.findByTestId("cancelled-banner")).toBeInTheDocument();
    expect(screen.getByTestId("reason-edit")).toHaveTextContent("A cancelled purchase cannot be edited.");
    expect(screen.getByTestId("action-edit")).toBeDisabled();
  });
});
