import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPickItem, Role } from "@farooq/shared";
import { mockApi, respond } from "../test/fetch-mock";
import { PIDS, purchaseDetail } from "../test/purchase-fixtures";

let role: Role = "OWNER";
const navigate = vi.fn();
let blockerOpts: { shouldBlockFn: () => boolean; enableBeforeUnload?: () => boolean } | null = null;
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", name: "Tester", username: "t", role }, isLoading: false }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: PIDS.purchase }),
  useBlocker: (o: { shouldBlockFn: () => boolean; enableBeforeUnload?: () => boolean }) => {
    blockerOpts = o;
    return { status: "idle", proceed: undefined, reset: undefined };
  },
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string> } & Record<string, unknown>) => (
    <a href={to.replace("$id", params?.id ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

import { PurchaseEditPage, PurchaseNewPage } from "./purchase-builder";
import { PurchaseChargesSection } from "../components/purchase-builder-parts";
import { ToastProvider } from "../components/ui";
import { blankPurchaseForm, NOTHING_ARRIVED_HINT, PAID_EDIT_HINT, purchasePaidRules } from "../lib/purchase-form";

const WH1 = PIDS.warehouse;
const WH2 = PIDS.warehouse2;
const SUPPLIER = { id: PIDS.supplier, name: "Zam Zam Mills", contact: "Mr Zam", phone: "0300-1", region: null, regionId: null, active: true };
const PRODUCT: ProductPickItem = {
  id: PIDS.product, name: "زم زم آٹا", nameEn: "Zam Zam Atta 20KG", nameUr: "زم زم آٹا", brand: "Zam Zam", category: "Flour", unit: "Bag", weightKg: 20, sku: null,
  sellP: 150_000, minSellP: 140_000, lastRateP: 148_000, taxPct: null, available: [{ warehouseId: WH1, quantity: 30 }], costP: null, buyP: null,
};
const WAREHOUSES = [
  { id: WH1, name: "Main Godown", active: true },
  { id: WH2, name: "Second Godown", active: true },
];

const baseRoutes = (extra: Record<string, unknown> = {}) => ({
  "GET /warehouses": WAREHOUSES,
  "GET /suppliers": [SUPPLIER],
  [`GET /suppliers/${PIDS.supplier}/balance`]: { partyId: PIDS.supplier, balanceP: 2_500_000 },
  "GET /products": [PRODUCT],
  "GET /purchases/last-rates": [],
  ...extra,
});

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
  navigate.mockReset();
  blockerOpts = null;
});

/** Chooses the supplier and adds the product like a person: type in the combobox, click the option, search, click the result. */
async function fillNewPurchase(user: ReturnType<typeof userEvent.setup>, ordered = "10") {
  const box = await screen.findByRole("combobox", { name: "Supplier" });
  await user.click(box);
  await user.click(await screen.findByRole("option", { name: /Zam Zam Mills/ }));
  await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zam");
  await user.click(await screen.findByTestId("product-result"));
  const q = await screen.findByLabelText("Ordered, line 1");
  if (ordered) await user.type(q, ordered);
}

describe("a new purchase", () => {
  it("starts empty: no supplier chosen (never pre-selected), no lines, the first active warehouse, the legacy banner about Received", async () => {
    mockApi(baseRoutes());
    wrap(<PurchaseNewPage />);
    expect(await screen.findByTestId("builder-title")).toHaveTextContent("Receive stock from a mill");
    expect(screen.getByRole("combobox", { name: "Supplier" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Supplier" })).toHaveAttribute("placeholder", "— Choose a supplier —");
    expect(screen.getByTestId("no-lines")).toBeInTheDocument();
    expect(screen.getByTestId("header-warehouse")).toHaveValue(WH1);
    expect(screen.getByTestId("summary-grand-total")).toHaveTextContent("PKR 0.00");
    expect(screen.getByTestId("received-banner")).toHaveTextContent(
      "Leave Received blank if the whole line arrived. Enter a smaller figure for a part delivery — only those bags go into stock and the rest stays open.",
    );
    expect(screen.getByTestId("save-purchase")).toHaveTextContent("Save & Receive Stock");
    expect(screen.queryByTestId("dirty-note")).toBeNull();
  });

  it("choosing a supplier shows what is payable to it now", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "");
    expect(await screen.findByTestId("supplier-balance")).toHaveTextContent("We owe supplier PKR 25,000.00");
  });

  it("the bill follows the ORDERED bags; the bags into stock follow Received (blank = all); every keystroke updates the total", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "");
    await waitFor(() => expect(screen.getByLabelText("Ordered, line 1")).toHaveFocus());
    await user.keyboard("10");
    await user.type(screen.getByLabelText("Rate, line 1"), "1000");
    expect(screen.getByTestId("line-amount")).toHaveTextContent("10,000.00");
    expect(screen.getByTestId("summary-ordered")).toHaveTextContent("10");
    expect(screen.getByTestId("summary-received")).toHaveTextContent("10");
    await user.type(screen.getByLabelText("Received, line 1"), "6");
    expect(screen.getByTestId("line-amount")).toHaveTextContent("10,000.00"); // the bill is for what was ordered
    expect(screen.getByTestId("summary-received")).toHaveTextContent("6");
    expect(screen.getByTestId("line-received-hint")).toHaveTextContent(/^Part delivery/);
    await user.type(screen.getByTestId("field-freight"), "500");
    await user.type(screen.getByTestId("field-paidAmount"), "3,000");
    expect(screen.getByTestId("summary-grand-total")).toHaveTextContent("PKR 10,500.00");
    expect(screen.getByTestId("summary-balance")).toHaveTextContent("PKR 7,500.00");
    expect(screen.getByTestId("sticky-total")).toHaveTextContent("PKR 10,500.00");
  });

  it("Enter moves through Ordered → Received → Rate → Discount instead of submitting", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "3");
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Received, line 1")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Rate, line 1")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Discount, line 1")).toHaveFocus();
  });

  it("Received 0 says the bill books with no stock and warns about the double count; the button becomes an order; blank again clears it", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "10");
    await user.type(screen.getByLabelText("Received, line 1"), "0");
    expect(screen.getByTestId("line-received-hint")).toHaveTextContent(NOTHING_ARRIVED_HINT);
    expect(screen.getByTestId("none-banner")).toBeInTheDocument();
    expect(screen.getByTestId("summary-received")).toHaveTextContent("0");
    expect(screen.getByTestId("save-purchase")).toHaveTextContent("Save order (no stock)");
    await user.clear(screen.getByLabelText("Received, line 1"));
    expect(screen.queryByTestId("line-received-hint")).toBeNull();
    expect(screen.queryByTestId("none-banner")).toBeNull();
    expect(screen.getByTestId("save-purchase")).toHaveTextContent("Save & Receive Stock");
  });

  it("a product bought before starts at the last rate paid, and the hint says when and on which purchase", async () => {
    mockApi(baseRoutes({ "GET /purchases/last-rates": [{ productId: PIDS.product, unitPriceP: 120_000, date: "2026-09-20", purchaseNumber: "PUR-2026-000007", supplierId: PIDS.supplier }] }));
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "");
    await waitFor(() => expect(screen.getByLabelText("Rate, line 1")).toHaveValue("1200"));
    expect(screen.getByTestId("line-last-rate")).toHaveTextContent("Last bought at PKR 1,200.00/bag on 20 Sep 2026 (PUR-2026-000007).");
  });

  it("a rate the person has already typed is never overwritten when the last rate arrives", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    mockApi(
      baseRoutes({
        "GET /purchases/last-rates": async () => (await gate, { body: [{ productId: PIDS.product, unitPriceP: 120_000, date: "2026-09-20", purchaseNumber: null, supplierId: null }] }),
      }),
    );
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "");
    await user.type(screen.getByLabelText("Rate, line 1"), "999");
    release();
    await waitFor(() => expect(screen.getByTestId("line-last-rate")).toBeInTheDocument());
    expect(screen.getByLabelText("Rate, line 1")).toHaveValue("999");
  });

  it("a product never bought has no starting rate and no hint", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "1");
    expect(screen.getByLabelText("Rate, line 1")).toHaveValue("");
    expect(screen.queryByTestId("line-last-rate")).toBeNull();
  });

  it("Save sends ONE request with the whole purchase, exactly as the form reads; a second click while it is on its way sends nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockApi(baseRoutes({ "POST /purchases": async () => (await gate, { status: 201, body: purchaseDetail() }) }));
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "10");
    await user.type(screen.getByLabelText("Received, line 1"), "6");
    await user.type(screen.getByLabelText("Rate, line 1"), "1000");
    await user.type(screen.getByTestId("field-supplierInvoiceNo"), "SB-5");
    const save = screen.getByTestId("save-purchase");
    await user.click(save);
    await user.click(save);
    await user.dblClick(save);
    release();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/purchases/$id", params: { id: PIDS.purchase } }));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      supplierId: PIDS.supplier,
      warehouseId: WH1,
      supplierInvoiceNo: "SB-5",
      lines: [{ productId: PIDS.product, quantity: 10, receivedQuantity: 6, unitPriceP: 100_000, discountP: 0, warehouseId: WH1 }],
      invoiceDiscountP: 0, freightP: 0, loadingP: 0, otherChargesP: 0, paidAmountP: 0, paymentMethod: "Cash",
    });
    expect(posts[0]!.body).not.toHaveProperty("revision");
    expect((posts[0]!.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });

  it("two clicks in the same instant (before the screen has re-drawn the button as busy) still send ONE request", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockApi(baseRoutes({ "POST /purchases": async () => (await gate, { status: 201, body: purchaseDetail() }) }));
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "10");
    const save = screen.getByTestId("save-purchase");
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    release();
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a NEW key for the next save after success; the SAME key when the last save failed (a failed save is safe to repeat)", async () => {
    let n = 0;
    const { calls } = mockApi(baseRoutes({ "POST /purchases": () => (++n === 1 ? { status: 422, body: { message: "No", errors: ["Line 1 (Zam Zam Atta 20KG): enter a rate per bag."] } } : { status: 201, body: purchaseDetail() }) }));
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "10");
    await user.click(screen.getByTestId("save-purchase"));
    await screen.findByTestId("save-errors");
    await user.click(screen.getByTestId("save-purchase"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    await user.click(screen.getByTestId("save-purchase")); // (the screen stays mounted in this test: the router is mocked)
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(3));
    const keys = calls.filter((c) => c.method === "POST").map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("a refusal shows EVERY line of the server's answer verbatim, marks the row a line message names, marks the supplier box, keeps the form as typed", async () => {
    const errors = ["Choose a supplier.", "Line 1 (Zam Zam Atta 20KG): enter a rate per bag."];
    mockApi(baseRoutes({ "POST /purchases": respond(422, { message: errors[0], errors }) }));
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "10");
    await user.click(screen.getByTestId("save-purchase"));
    const banner = await screen.findByTestId("save-errors");
    expect(banner).toHaveTextContent("This purchase cannot be saved yet — nothing has been changed");
    for (const e of errors) expect(within(banner).getByText(e)).toBeInTheDocument();
    expect(within(screen.getByTestId("line-row")).getByTestId("line-error")).toHaveTextContent(errors[1]!);
    expect(screen.getByRole("combobox", { name: "Supplier" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Ordered, line 1")).toHaveValue("10");
    expect(screen.getByTestId("save-purchase")).toBeEnabled();
  });

  it("a network failure says nothing was saved and keeps the form", async () => {
    const { calls } = mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "4");
    await user.click(screen.getByTestId("save-purchase"));
    expect(await screen.findByTestId("save-errors")).toHaveTextContent("Could not reach the server — nothing was saved. Your form is exactly as you left it; try again.");
    expect(screen.getByLabelText("Ordered, line 1")).toHaveValue("4");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("text that cannot be a number is named by line and never sent", async () => {
    const { calls } = mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "2.5555");
    await user.click(screen.getByTestId("save-purchase"));
    expect(await screen.findByTestId("save-errors")).toHaveTextContent("Line 1: Enter the number of bags — at most 3 decimal places");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a paid amount refused for lack of permission (403) says the WHOLE save was refused", async () => {
    const msg = "You do not have permission to pay a supplier. Clear the amount paid, or ask someone who can record payments.";
    mockApi(baseRoutes({ "POST /purchases": respond(403, { message: msg }) }));
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "10");
    await user.click(screen.getByTestId("save-purchase"));
    const banner = await screen.findByTestId("save-errors");
    expect(banner).toHaveTextContent("the whole save was refused and nothing was changed");
    expect(banner).toHaveTextContent(msg);
  });

  it("lines can be moved and removed; the header warehouse rewrites every line's warehouse, a line's own godown changes only that line", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "1");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zam");
    await user.click(await screen.findByTestId("product-result"));
    expect(await screen.findAllByTestId("line-row")).toHaveLength(2);
    await user.selectOptions(screen.getByTestId("header-warehouse"), WH2);
    for (const s of screen.getAllByTestId("line-warehouse")) expect(s).toHaveValue(WH2);
    await user.selectOptions(screen.getAllByTestId("line-warehouse")[0]!, WH1);
    expect(screen.getAllByTestId("line-warehouse").map((s) => (s as HTMLSelectElement).value)).toEqual([WH1, WH2]);
    await user.click(screen.getByRole("button", { name: "Remove line 1" }));
    expect(screen.getAllByTestId("line-row")).toHaveLength(1);
  });
});

describe("leaving with changes", () => {
  it("is guarded only while the form differs from the snapshot; a character typed and deleted again is not a change", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await screen.findByTestId("builder-title");
    expect(blockerOpts!.shouldBlockFn()).toBe(false);
    await user.type(screen.getByTestId("field-notes"), "x");
    expect(blockerOpts!.shouldBlockFn()).toBe(true);
    expect(blockerOpts!.enableBeforeUnload!()).toBe(true);
    expect(screen.getByTestId("dirty-note")).toBeInTheDocument();
    await user.clear(screen.getByTestId("field-notes"));
    expect(blockerOpts!.shouldBlockFn()).toBe(false);
  });

  it("a successful save lets the coming navigation through even though the form differs from where it started", async () => {
    mockApi(baseRoutes({ "POST /purchases": respond(201, purchaseDetail()) }));
    const user = userEvent.setup();
    wrap(<PurchaseNewPage />);
    await fillNewPurchase(user, "1");
    expect(blockerOpts!.shouldBlockFn()).toBe(true);
    const askedAtNavigate: boolean[] = [];
    navigate.mockImplementation(() => {
      askedAtNavigate.push(blockerOpts!.shouldBlockFn(), blockerOpts!.enableBeforeUnload!());
    });
    await user.click(screen.getByTestId("save-purchase"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(askedAtNavigate).toEqual([false, false]);
  });
});

describe("editing", () => {
  const editRoutes = (pu: ReturnType<typeof purchaseDetail>, extra: Record<string, unknown> = {}) => baseRoutes({ [`GET /purchases/${PIDS.purchase}`]: pu, ...extra });

  it("asks first ('Edit a purchase that is already in stock?'); Continue opens the form with its lines, Ordered / Received as saved and the supplier LOCKED with the server's reason", async () => {
    const pu = purchaseDetail();
    mockApi(editRoutes(pu));
    const user = userEvent.setup();
    wrap(<PurchaseEditPage />);
    const gate = await screen.findByRole("dialog", { name: "Edit a purchase that is already in stock?" });
    expect(gate).toHaveTextContent("Editing it will adjust stock and the supplier balance by the difference, and the change is recorded in the audit log.");
    await user.click(within(gate).getByTestId("gate-continue"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("builder-title")).toHaveTextContent("Edit PUR-2026-000007");
    expect(screen.queryByRole("combobox", { name: "Supplier" })).toBeNull();
    expect(screen.getByTestId("supplier-locked")).toHaveTextContent("Zam Zam Mills");
    expect(screen.getByTestId("supplier-locked-hint")).toHaveTextContent(pu.actions.changeSupplier.reason!);
    expect(screen.getByLabelText("Ordered, line 1")).toHaveValue("10");
    expect(screen.getByLabelText("Received, line 1")).toHaveValue("6");
    expect(screen.getByLabelText("Rate, line 1")).toHaveValue("1000");
    expect(screen.getByTestId("field-freight")).toHaveValue("500");
    expect(screen.getByTestId("field-supplierInvoiceNo")).toHaveValue("SB-5");
    expect(screen.getByTestId("save-purchase")).toHaveTextContent("Save changes");
  });

  it("the amount paid starts at what has been paid with the legacy hint; below it is called out; the payment method is for what is added", async () => {
    mockApi(editRoutes(purchaseDetail()));
    const user = userEvent.setup();
    wrap(<PurchaseEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    expect(screen.getByTestId("field-paidAmount")).toHaveValue("3000");
    expect(screen.getByText(PAID_EDIT_HINT)).toBeInTheDocument();
    expect(screen.queryByTestId("paid-lowered")).toBeNull();
    await user.clear(screen.getByTestId("field-paidAmount"));
    await user.type(screen.getByTestId("field-paidAmount"), "2000");
    expect(screen.getByTestId("paid-lowered")).toHaveTextContent("PKR 3,000.00 has already been paid against this purchase. The amount paid cannot be lowered here — reverse that payment voucher from Payments instead.");
    await user.clear(screen.getByTestId("field-paidAmount"));
    await user.type(screen.getByTestId("field-paidAmount"), "3500");
    expect(screen.queryByTestId("paid-lowered")).toBeNull();
  });

  it("saving sends a PUT with the revision as loaded, the line id kept and ONLY the part delivery's receivedQuantity; the supplier is the same", async () => {
    const pu = purchaseDetail();
    const { calls } = mockApi(editRoutes(pu, { [`PUT /purchases/${PIDS.purchase}`]: respond(200, { ...pu, revision: 4 }) }));
    const user = userEvent.setup();
    wrap(<PurchaseEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    await user.clear(screen.getByLabelText("Received, line 1"));
    await user.type(screen.getByLabelText("Received, line 1"), "8");
    await user.clear(screen.getByTestId("field-paidAmount"));
    await user.type(screen.getByTestId("field-paidAmount"), "4000");
    await user.click(screen.getByTestId("save-purchase"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/purchases/$id", params: { id: PIDS.purchase } }));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      revision: 3,
      supplierId: PIDS.supplier,
      supplierInvoiceNo: "SB-5",
      vehicleNo: "103",
      driver: "Aslam",
      freightP: 50_000,
      paidAmountP: 400_000,
      lines: [{ id: PIDS.line, productId: PIDS.product, quantity: 10, receivedQuantity: 8, unitPriceP: 100_000, warehouseId: WH1 }],
    });
  });

  it("a line that arrived whole is saved with NO receivedQuantity (blank = all follows the ordered bags)", async () => {
    const base = purchaseDetail();
    const pu = purchaseDetail({ lines: [{ ...base.lines[0]!, receivedQuantity: 10, receivedQtyMilli: 10_000 }], status: "RECEIVED" });
    const { calls } = mockApi(editRoutes(pu, { [`PUT /purchases/${PIDS.purchase}`]: respond(200, pu) }));
    const user = userEvent.setup();
    wrap(<PurchaseEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    expect(screen.getByLabelText("Received, line 1")).toHaveValue("");
    await user.click(screen.getByTestId("save-purchase"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).not.toHaveProperty("lines.0.receivedQuantity");
  });

  it("a stale revision shows the server's words and offers Reload; Reload fetches the purchase again and replaces the form without asking again", async () => {
    const pu = purchaseDetail();
    const stale = "This purchase was changed by someone else since you opened it. Reload it and make your change again.";
    let reads = 0;
    const { calls } = mockApi(
      editRoutes(pu, {
        [`GET /purchases/${PIDS.purchase}`]: () => ({ body: ++reads === 1 ? pu : { ...pu, revision: 4, lines: [{ ...pu.lines[0]!, quantity: 7, qtyMilli: 7_000 }] } }),
        [`PUT /purchases/${PIDS.purchase}`]: respond(422, { message: stale, errors: [stale] }),
      }),
    );
    const user = userEvent.setup();
    wrap(<PurchaseEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    await user.click(screen.getByTestId("save-purchase"));
    expect(await screen.findByTestId("save-errors")).toHaveTextContent(stale);
    await user.click(screen.getByTestId("reload-purchase"));
    await waitFor(() => expect(screen.getByLabelText("Ordered, line 1")).toHaveValue("7"));
    expect(screen.queryByTestId("save-errors")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter((c) => c.method === "GET" && c.path === `/purchases/${PIDS.purchase}`)).toHaveLength(2);
  });

  it("a line with bags returned to the supplier says why it cannot be removed, keeps its godown when the header changes, and warns when Received goes below the bags returned", async () => {
    const base = purchaseDetail();
    const pu = purchaseDetail({ lines: [{ ...base.lines[0]!, returnedQuantity: 4 }], actions: { edit: { allowed: true, reason: null }, changeSupplier: { allowed: true, reason: null } } });
    mockApi(editRoutes(pu));
    const user = userEvent.setup();
    wrap(<PurchaseEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    expect(screen.getByTestId("line-lock")).toHaveTextContent(/^4 bags have been returned to the supplier, so this line cannot be removed/);
    expect(screen.getByRole("button", { name: "Remove line 1" })).toBeDisabled();
    expect(screen.getByTestId("line-warehouse")).toBeDisabled();
    await user.selectOptions(screen.getByTestId("header-warehouse"), WH2);
    expect(screen.getByTestId("line-warehouse")).toHaveValue(WH1);
    expect(screen.queryByTestId("line-returned-hint")).toBeNull();
    await user.clear(screen.getByLabelText("Received, line 1"));
    await user.type(screen.getByLabelText("Received, line 1"), "3");
    expect(screen.getByTestId("line-returned-hint")).toHaveTextContent("4 bags were already returned to the supplier, so fewer than that cannot be shown as received.");
    // the supplier is free to change here: the server said so
    expect(screen.getByRole("combobox", { name: "Supplier" })).toBeInTheDocument();
  });

  it("a line already on the purchase is not told 'last bought at' its own rate; a line added here is", async () => {
    const pu = purchaseDetail();
    mockApi(editRoutes(pu, { "GET /purchases/last-rates": [{ productId: PIDS.product, unitPriceP: 100_000, date: "2026-09-20", purchaseNumber: pu.number, supplierId: PIDS.supplier }] }));
    const user = userEvent.setup();
    wrap(<PurchaseEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    await screen.findByLabelText("Ordered, line 1");
    await waitFor(() => expect(screen.getByLabelText("Rate, line 1")).toHaveValue("1000"));
    expect(screen.queryByTestId("line-last-rate")).toBeNull();
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zam");
    await user.click(await screen.findByTestId("product-result"));
    await waitFor(() => expect(screen.getAllByTestId("line-row")).toHaveLength(2));
    expect(within(screen.getAllByTestId("line-row")[1]!).getByTestId("line-last-rate")).toHaveTextContent("Last bought at PKR 1,000.00/bag");
  });

  it("a purchase the server will not let this role edit shows its reason, not a form", async () => {
    const reason = "A cancelled purchase cannot be edited.";
    mockApi(editRoutes(purchaseDetail({ status: "CANCELLED", actions: { edit: { allowed: false, reason }, changeSupplier: { allowed: false, reason } } })));
    wrap(<PurchaseEditPage />);
    expect(await screen.findByTestId("edit-refused")).toHaveTextContent(reason);
    expect(screen.queryByTestId("purchase-builder")).toBeNull();
  });

  it("an unknown purchase says so", async () => {
    mockApi(baseRoutes({ [`GET /purchases/${PIDS.purchase}`]: respond(404, { message: "Purchase not found." }) }));
    wrap(<PurchaseEditPage />);
    expect(await screen.findByText("Purchase not found")).toBeInTheDocument();
  });
});

describe("who may build", () => {
  it.each(["OWNER", "MANAGER"] as const)("%s gets the new-purchase form", async (r) => {
    role = r;
    mockApi(baseRoutes());
    wrap(<PurchaseNewPage />);
    expect(await screen.findByTestId("builder-title")).toBeInTheDocument();
  });

  it("the accountant reads and corrects purchases but does not record new ones", async () => {
    role = "ACCOUNTANT";
    mockApi(baseRoutes());
    wrap(<PurchaseNewPage />);
    expect(await screen.findByTestId("not-available")).toHaveTextContent(/Not available for the/);
    expect(screen.queryByTestId("purchase-builder")).toBeNull();
  });

  it("…but may edit a recorded one (TRANSACTION_CORRECT)", async () => {
    role = "ACCOUNTANT";
    mockApi(baseRoutes({ [`GET /purchases/${PIDS.purchase}`]: purchaseDetail() }));
    wrap(<PurchaseEditPage />);
    expect(await screen.findByTestId("gate-continue")).toBeInTheDocument();
  });

  it.each(["SALES", "INVENTORY"] as const)("%s gets 'Not available' for both screens and nothing is fetched", async (r) => {
    role = r;
    const { calls } = mockApi(baseRoutes());
    const a = wrap(<PurchaseNewPage />);
    expect(await screen.findByTestId("not-available")).toHaveTextContent(/Not available for the/);
    a.unmount();
    wrap(<PurchaseEditPage />);
    expect(await screen.findByTestId("not-available")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith("/purchases"))).toEqual([]);
  });
});

describe("the Amount Paid box", () => {
  it("is disabled, with the reason, for someone who may not pay a supplier — and so is the payment method", () => {
    const form = { ...blankPurchaseForm(WH1), paidAmount: "3000" };
    render(
      <PurchaseChargesSection
        form={form}
        dispatch={() => undefined}
        paid={purchasePaidRules({ canPayOut: false, editing: true })}
        totals={{ grandTotalP: 1_050_000, paidP: 300_000 } as never}
        editing
      />,
    );
    expect(screen.getByTestId("field-paidAmount")).toBeDisabled();
    expect(screen.getByTestId("field-paidAmount")).toHaveValue("3000");
    expect(screen.getByTestId("field-paymentMethod")).toBeDisabled();
    expect(screen.getByText(/do not have permission to pay a supplier/)).toBeInTheDocument();
  });
});
