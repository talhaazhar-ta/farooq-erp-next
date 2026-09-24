import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPickItem, Role } from "@farooq/shared";
import { mockApi, respond } from "../test/fetch-mock";
import { IDS, invoiceDetail } from "../test/invoice-fixtures";

let role: Role = "OWNER";
let editId = IDS.invoice;
const navigate = vi.fn();
let blockerOpts: { shouldBlockFn: () => boolean; enableBeforeUnload?: () => boolean } | null = null;
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", name: "Tester", username: "t", role }, isLoading: false }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: editId }),
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

import { InvoiceEditPage, InvoiceNewPage } from "./invoice-builder";
import { paidRules } from "../components/invoice-builder-parts";
import { ToastProvider } from "../components/ui";

const WH1 = "55555555-5555-4555-8555-555555555555";
const WH2 = "55555555-5555-4555-8555-555555555556";
const SHOP = { id: IDS.shop, name: "Alpha Store", contact: "Noor", phone: "0300-1", region: "Drosh", regionId: null, active: true };
const PRODUCT: ProductPickItem = {
  id: IDS.product, name: "زم زم آٹا", nameEn: "Zam Zam Atta 20KG", nameUr: "زم زم آٹا", brand: "Zam Zam", category: "Flour", unit: "Bag", weightKg: 20, sku: null,
  sellP: 150_000, minSellP: 140_000, lastRateP: 148_000, taxPct: null, available: [{ warehouseId: WH1, quantity: 30 }], costP: null, buyP: null,
};
const WAREHOUSES = [
  { id: WH1, name: "Main Godown", active: true },
  { id: WH2, name: "Second Godown", active: true },
];

const baseRoutes = (extra: Record<string, unknown> = {}) => ({
  "GET /warehouses": WAREHOUSES,
  "GET /regions": [],
  "GET /customers": [SHOP],
  [`GET /customers/${IDS.shop}/balance`]: { partyId: IDS.shop, balanceP: 100_000 },
  "GET /products": [PRODUCT],
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
  editId = IDS.invoice;
  navigate.mockReset();
  blockerOpts = null;
});

/** Chooses the shop and adds the product, like a person: type in the combobox, click the option, search, click the result. */
async function fillNewInvoice(user: ReturnType<typeof userEvent.setup>, qty = "10") {
  const shop = await screen.findByRole("combobox", { name: "Shop" });
  await user.click(shop);
  await user.click(await screen.findByRole("option", { name: /Alpha Store/ }));
  await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zam");
  await user.click(await screen.findByTestId("product-result"));
  const q = await screen.findByLabelText("Quantity, line 1");
  if (qty) await user.type(q, qty);
}

describe("a new invoice", () => {
  it("starts empty: no shop chosen, no lines, the first active warehouse", async () => {
    mockApi(baseRoutes());
    wrap(<InvoiceNewPage />);
    expect(await screen.findByTestId("builder-title")).toHaveTextContent("New invoice");
    expect(screen.getByRole("combobox", { name: "Shop" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Shop" })).toHaveAttribute("placeholder", "— Choose a shop —");
    expect(screen.getByTestId("no-lines")).toBeInTheDocument();
    expect(screen.getByTestId("header-warehouse")).toHaveValue(WH1);
    expect(screen.getByTestId("summary-grand-total")).toHaveTextContent("PKR 0.00");
    expect(screen.queryByTestId("dirty-note")).toBeNull();
  });

  it("adding a product starts the rate at the owner's set price and puts the cursor in the Qty box; the total follows every keystroke", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "");
    expect(screen.getByLabelText("Rate, line 1")).toHaveValue("1500");
    await waitFor(() => expect(screen.getByLabelText("Quantity, line 1")).toHaveFocus());
    await user.keyboard("2.5");
    expect(screen.getByTestId("line-amount")).toHaveTextContent("3,750.00");
    expect(screen.getByTestId("summary-grand-total")).toHaveTextContent("PKR 3,750.00");
    expect(screen.getByTestId("sticky-total")).toHaveTextContent("PKR 3,750.00");
    await user.type(screen.getByTestId("field-freight"), "150.50");
    await user.type(screen.getByTestId("field-paidAmount"), "1,000");
    expect(screen.getByTestId("summary-grand-total")).toHaveTextContent("PKR 3,900.50");
    expect(screen.getByTestId("summary-balance")).toHaveTextContent("PKR 2,900.50");
    expect(screen.getByTestId("shop-balance")).toHaveTextContent("Shop owes us PKR 1,000.00");
  });

  it("Enter moves to the next quantity / rate / discount box instead of submitting", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "3");
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Rate, line 1")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Discount, line 1")).toHaveFocus();
  });

  it("Post invoice sends ONE request with the whole invoice, exactly as the form reads; a second click while it is on its way sends nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockApi(baseRoutes({ "POST /invoices": async () => (await gate, { status: 201, body: invoiceDetail() }) }));
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "10");
    const post = screen.getByTestId("save-post");
    await user.click(post);
    await user.click(post);
    await user.dblClick(post);
    release();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/invoices/$id", params: { id: IDS.invoice } }));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      mode: "post",
      customerId: IDS.shop,
      warehouseId: WH1,
      lines: [{ productId: IDS.product, quantity: 10, unitPriceP: 150_000, discountP: 0, warehouseId: WH1 }],
      invoiceDiscountP: 0, freightP: 0, loadingP: 0, otherChargesP: 0, paidAmountP: 0, paymentMethod: "Cash",
    });
    expect(posts[0]!.body).not.toHaveProperty("revision");
    expect((posts[0]!.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });

  it("a NEW key for the next save after success; the SAME key when the last save failed (a failed save is safe to repeat)", async () => {
    let n = 0;
    const { calls } = mockApi(
      baseRoutes({
        "POST /invoices": () => (++n === 1 ? { status: 422, body: { message: "Only 3 bags", errors: ["Only 3 bags of Zam Zam Atta 20KG are available in Main Godown. Requested: 10."] } } : { status: 201, body: invoiceDetail() }),
      }),
    );
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "10");
    await user.click(screen.getByTestId("save-post"));
    await screen.findByTestId("save-errors");
    await user.click(screen.getByTestId("save-post"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    await user.click(screen.getByTestId("save-post")); // (the screen stays mounted in this test: the router is mocked)
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(3));
    const keys = calls.filter((c) => c.method === "POST").map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).toBe(keys[0]); // retry after a refusal
    expect(keys[2]).not.toBe(keys[1]); // after a success, a new save
  });

  it("a refusal shows EVERY line of the server's answer verbatim, marks the row a line message names, keeps the form exactly as typed, and says nothing was changed", async () => {
    const errors = ["Choose a shop to invoice.", "Line 1 (Zam Zam Atta 20KG): enter a rate per bag.", "Only 3 bags of Zam Zam Atta 20KG are available in Main Godown. Requested: 10."];
    mockApi(baseRoutes({ "POST /invoices": respond(422, { message: errors[0], errors }) }));
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "10");
    await user.clear(screen.getByLabelText("Rate, line 1"));
    await user.click(screen.getByTestId("save-post"));
    const banner = await screen.findByTestId("save-errors");
    expect(banner).toHaveTextContent("This invoice cannot be saved yet — nothing has been changed");
    for (const e of errors) expect(within(banner).getByText(e)).toBeInTheDocument();
    expect(within(screen.getByTestId("line-row")).getByTestId("line-error")).toHaveTextContent(errors[1]!); // marked on its row
    expect(screen.getByLabelText("Quantity, line 1")).toHaveValue("10"); // the form is untouched
    expect(screen.getByRole("combobox", { name: "Shop" })).toHaveValue("Alpha Store");
    expect(screen.getByTestId("save-post")).toBeEnabled();
  });

  it("a network failure says nothing was saved and keeps the form; the button works again", async () => {
    const { calls } = mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "4");
    // no POST route: the mock throws, which the client turns into a network error
    await user.click(screen.getByTestId("save-post"));
    const banner = await screen.findByTestId("save-errors");
    expect(banner).toHaveTextContent("Could not reach the server — nothing was saved. Your form is exactly as you left it; try again.");
    expect(screen.getByLabelText("Quantity, line 1")).toHaveValue("4");
    expect(screen.getByTestId("save-post")).toBeEnabled();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("text that cannot be a number is named by line and never sent", async () => {
    const { calls } = mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "2.5555");
    await user.click(screen.getByTestId("save-post"));
    expect(await screen.findByTestId("save-errors")).toHaveTextContent("Line 1: Enter the number of bags — at most 3 decimal places");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Save draft sends mode draft; whatever was typed as paid goes with it and the server's refusal is shown", async () => {
    const refusal = "Payment can only be taken when the invoice is posted. Clear the amount paid, or post the invoice.";
    const { calls } = mockApi(baseRoutes({ "POST /invoices": respond(422, { message: refusal, errors: [refusal] }) }));
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "1");
    await user.type(screen.getByTestId("field-paidAmount"), "500");
    await user.click(screen.getByTestId("save-draft"));
    expect(await screen.findByTestId("save-errors")).toHaveTextContent(refusal);
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ mode: "draft", paidAmountP: 50_000 });
  });

  it("shortage is a warning, never a block: the line and the header say 'short by', Save is still offered", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "45");
    expect(await screen.findByTestId("line-avail")).toHaveTextContent("30 available · short by 15");
    expect(screen.getByTestId("short-count")).toHaveTextContent("1 line short of stock");
    expect(screen.getByTestId("stock-warning")).toBeInTheDocument();
    expect(screen.getByTestId("save-post")).toBeEnabled();
  });

  it("two lines of one product are totalled against the stock", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "20");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zam");
    await user.click(await screen.findByTestId("product-result"));
    await user.type(await screen.findByLabelText("Quantity, line 2"), "20");
    const avail = await screen.findAllByTestId("line-avail");
    expect(avail).toHaveLength(2);
    for (const a of avail) expect(a).toHaveTextContent("30 available · short by 10");
    expect(screen.getByTestId("short-count")).toHaveTextContent("2 lines short of stock");
  });

  it("lines can be moved and removed; the header warehouse rewrites every line's warehouse", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "1");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zam");
    await user.click(await screen.findByTestId("product-result"));
    expect(await screen.findAllByTestId("line-row")).toHaveLength(2);
    await user.selectOptions(screen.getByTestId("header-warehouse"), WH2);
    for (const s of screen.getAllByTestId("line-warehouse")) expect(s).toHaveValue(WH2);
    await user.click(screen.getByRole("button", { name: "Remove line 1" }));
    expect(screen.getAllByTestId("line-row")).toHaveLength(1);
  });
});

describe("leaving with changes", () => {
  it("is guarded only while the form differs from the snapshot; a character typed and deleted again is not a change", async () => {
    mockApi(baseRoutes());
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await screen.findByTestId("builder-title");
    expect(blockerOpts!.shouldBlockFn()).toBe(false);
    expect(blockerOpts!.enableBeforeUnload!()).toBe(false);
    await user.type(screen.getByTestId("field-notes"), "x");
    expect(blockerOpts!.shouldBlockFn()).toBe(true);
    expect(blockerOpts!.enableBeforeUnload!()).toBe(true);
    expect(screen.getByTestId("dirty-note")).toBeInTheDocument();
    await user.clear(screen.getByTestId("field-notes"));
    expect(blockerOpts!.shouldBlockFn()).toBe(false);
    expect(screen.queryByTestId("dirty-note")).toBeNull();
  });

  it("a successful save lets the coming navigation through even though the form differs from where it started", async () => {
    mockApi(baseRoutes({ "POST /invoices": respond(201, invoiceDetail()) }));
    const user = userEvent.setup();
    wrap(<InvoiceNewPage />);
    await fillNewInvoice(user, "1");
    expect(blockerOpts!.shouldBlockFn()).toBe(true);
    // the real router asks at the very moment navigate() is called, before React has re-rendered with the new snapshot
    const askedAtNavigate: boolean[] = [];
    navigate.mockImplementation(() => {
      askedAtNavigate.push(blockerOpts!.shouldBlockFn(), blockerOpts!.enableBeforeUnload!());
    });
    await user.click(screen.getByTestId("save-post"));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(askedAtNavigate).toEqual([false, false]);
    expect(blockerOpts!.shouldBlockFn()).toBe(false);
    expect(blockerOpts!.enableBeforeUnload!()).toBe(false);
  });
});

describe("editing", () => {
  const posted = () =>
    invoiceDetail({
      status: "PARTIALLY_PAID",
      paymentStatus: "PARTIAL",
      paidP: 400_000,
      revision: 5,
      receipts: [{ paymentId: IDS.receipt, receiptNumber: "REC-2026-000031", date: "2026-09-02", method: "Cash", reference: null, allocatedP: 400_000, status: "POSTED" }],
      lines: [{ ...invoiceDetail().lines[0]!, quantity: 20, qtyMilli: 20_000, unitPriceP: 135_000, lineTotalP: 2_700_000 }],
      totalP: 2_700_000,
      warehouseId: WH1,
    });
  const editRoutes = (inv: ReturnType<typeof posted>, extra: Record<string, unknown> = {}) => baseRoutes({ [`GET /invoices/${IDS.invoice}`]: inv, ...extra });

  it("a posted invoice asks first ('Edit a confirmed invoice?'); Continue opens the form with its lines, the shop LOCKED with the hint, the amount paid at what is already received, and no Save draft", async () => {
    mockApi(editRoutes(posted()));
    const user = userEvent.setup();
    wrap(<InvoiceEditPage />);
    const gate = await screen.findByRole("dialog", { name: "Edit a confirmed invoice?" });
    expect(gate).toHaveTextContent("adjust stock and the shop’s balance by the difference");
    await user.click(within(gate).getByTestId("gate-continue"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("builder-title")).toHaveTextContent("Edit INV-2026-000001");
    expect(screen.queryByRole("combobox", { name: "Shop" })).toBeNull();
    expect(screen.getByTestId("shop-locked")).toHaveTextContent("Alpha Store");
    expect(screen.getByTestId("shop-locked-hint")).toHaveTextContent("Change shop");
    expect(screen.getByLabelText("Quantity, line 1")).toHaveValue("20");
    expect(screen.getByLabelText("Rate, line 1")).toHaveValue("1350");
    expect(screen.getByTestId("field-paidAmount")).toHaveValue("4000");
    expect(screen.getByText(/Already received: PKR 4,000.00/)).toBeInTheDocument();
    expect(screen.queryByTestId("save-draft")).toBeNull();
    expect(screen.getByTestId("save-post")).toHaveTextContent("Save changes");
    expect(screen.getByTestId("summary-previous")).toHaveTextContent("PKR 1,000.00"); // frozen at posting
  });

  it("saving sends a PUT with the revision as loaded and the line ids kept; the invoice's own bags count back in the stock hint", async () => {
    const inv = posted();
    const { calls } = mockApi(
      editRoutes(inv, { [`PUT /invoices/${IDS.invoice}`]: respond(200, { ...inv, revision: 6 }), "GET /products": [{ ...PRODUCT, available: [{ warehouseId: WH1, quantity: 5 }] }] }),
    );
    const user = userEvent.setup();
    wrap(<InvoiceEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    // 5 in the godown + the invoice's own 20 = 25 can go on this invoice: 24 is fine, 26 is short by 1
    await user.clear(screen.getByLabelText("Quantity, line 1"));
    await user.type(screen.getByLabelText("Quantity, line 1"), "26");
    expect(await screen.findByTestId("line-avail")).toHaveTextContent("25 available · short by 1");
    await user.clear(screen.getByLabelText("Quantity, line 1"));
    await user.type(screen.getByLabelText("Quantity, line 1"), "24");
    await waitFor(() => expect(screen.getByTestId("line-avail")).toHaveTextContent(/^25 available$/));
    await user.click(screen.getByTestId("save-post"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/invoices/$id", params: { id: IDS.invoice } }));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ mode: "post", revision: 5, customerId: IDS.shop, paidAmountP: 400_000, lines: [{ id: IDS.line, productId: IDS.product, quantity: 24, unitPriceP: 135_000 }] });
  });

  it("a stale revision shows the server's words and offers Reload; Reload fetches the invoice again and replaces the form", async () => {
    const inv = posted();
    const stale = "This invoice was changed by someone else since you opened it. Reload it and make your change again.";
    let reads = 0;
    const { calls } = mockApi(
      editRoutes(inv, {
        [`GET /invoices/${IDS.invoice}`]: () => ({ body: ++reads === 1 ? inv : { ...inv, revision: 6, lines: [{ ...inv.lines[0]!, quantity: 7, qtyMilli: 7_000 }] } }),
        [`PUT /invoices/${IDS.invoice}`]: respond(422, { message: stale, errors: [stale] }),
      }),
    );
    const user = userEvent.setup();
    wrap(<InvoiceEditPage />);
    await user.click(await screen.findByTestId("gate-continue"));
    await user.click(screen.getByTestId("save-post"));
    expect(await screen.findByTestId("save-errors")).toHaveTextContent(stale);
    await user.click(screen.getByTestId("reload-invoice"));
    // the form is rebuilt from the fresh copy (quantity 7, no error banner) without asking the edit question a second time
    await waitFor(() => expect(screen.getByLabelText("Quantity, line 1")).toHaveValue("7"));
    expect(screen.queryByTestId("save-errors")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter((c) => c.method === "GET" && c.path === `/invoices/${IDS.invoice}`)).toHaveLength(2);
  });

  it("an invoice the server will not let this role edit shows its reason, not a form", async () => {
    const reason = "You do not have permission to edit a posted invoice, cancel it or change its shop.";
    mockApi(editRoutes({ ...posted(), actions: { ...posted().actions, edit: { allowed: false, reason } } }));
    wrap(<InvoiceEditPage />);
    expect(await screen.findByTestId("edit-refused")).toHaveTextContent(reason);
    expect(screen.queryByTestId("invoice-builder")).toBeNull();
  });

  it("a saved draft opens without the question, with its shop chosen, a Discard draft button and a Save draft button", async () => {
    mockApi(editRoutes(invoiceDetail({ status: "DRAFT", number: null, stockApplied: false, stockMovements: [], paidP: 0 })));
    wrap(<InvoiceEditPage />);
    expect(await screen.findByTestId("builder-title")).toHaveTextContent("Edit draft");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Shop" })).toHaveValue("Alpha Store");
    expect(screen.getByTestId("discard")).toHaveTextContent("Discard draft");
    expect(screen.getByTestId("save-draft")).toBeInTheDocument();
    expect(screen.getByTestId("save-post")).toHaveTextContent("Post invoice");
    expect(screen.getByTestId("field-paidAmount")).toHaveValue("");
  });
});

describe("who may build", () => {
  it.each(["OWNER", "MANAGER", "SALES"] as const)("%s gets the builder", async (r) => {
    role = r;
    mockApi(baseRoutes());
    wrap(<InvoiceNewPage />);
    expect(await screen.findByTestId("builder-title")).toBeInTheDocument();
  });
  it.each(["ACCOUNTANT", "INVENTORY"] as const)("%s gets 'Not available for the … role' and no form", async (r) => {
    role = r;
    mockApi(baseRoutes());
    wrap(<InvoiceNewPage />);
    expect(await screen.findByTestId("not-available")).toHaveTextContent(/Not available for the/);
    expect(screen.queryByTestId("invoice-builder")).toBeNull();
  });
});

describe("the Amount Paid box", () => {
  it("is disabled without permission to take payment, with the reason; the hint differs for a new, a draft and a posted invoice", () => {
    expect(paidRules({ canTakePayment: false, posted: false, receivedP: 0 })).toMatchObject({ disabled: true });
    expect(paidRules({ canTakePayment: false, posted: false, receivedP: 0 }).hint).toMatch(/do not have permission to take payment/);
    expect(paidRules({ canTakePayment: true, posted: false, receivedP: 0 })).toMatchObject({ disabled: false, hint: expect.stringContaining("Leave at 0 for a credit sale") });
    expect(paidRules({ canTakePayment: true, posted: true, receivedP: 400_000 }).hint).toMatch(/Already received: PKR 4,000.00\. It cannot go below that/);
  });
});
