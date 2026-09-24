import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockApi, respond } from "../test/fetch-mock";
import { IDS, invoiceDetail } from "../test/invoice-fixtures";

// the dialogs navigate / link; there is no router in a component test
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string> } & Record<string, unknown>) => (
    <a href={to.replace("$id", params?.id ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

import { CancelInvoiceDialog, ChangeShopPanel, PostDraftDialog } from "./invoice-dialogs";
import { ToastProvider } from "./ui";

const receipt = { paymentId: IDS.receipt, receiptNumber: "REC-2026-000031", date: "2026-09-02", method: "Cash", reference: null, allocatedP: 400_000, status: "POSTED" as const };
const SHOP = { id: IDS.shop, name: "Alpha Store", contact: "Noor", phone: "0300-1", region: "Drosh", regionId: null, active: true };
const OTHER = { id: IDS.other, name: "Beta Traders", contact: null, phone: null, region: null, regionId: null, active: true };

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => navigate.mockReset());

describe("Cancel invoice / Discard draft", () => {
  it("states the effect first and will not send anything until a reason is written", async () => {
    const { calls } = mockApi({ [`POST /invoices/${IDS.invoice}/cancel`]: invoiceDetail({ status: "CANCELLED" }) });
    const user = userEvent.setup();
    wrap(<CancelInvoiceDialog invoice={invoiceDetail()} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Cancel INV-2026-000001?" })).toBeInTheDocument();
    expect(screen.getByText(/bags come back into stock/)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Cancel invoice" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Reason"), "   ");
    expect(confirm).toBeDisabled(); // blanks are not a reason
    await user.clear(screen.getByLabelText("Reason"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    await user.type(screen.getByLabelText("Reason"), "  customer changed his mind ");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ reason: "customer changed his mind" });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it("a draft says 'Discard', and tells the person nothing else changes", () => {
    wrap(<CancelInvoiceDialog invoice={invoiceDetail({ status: "DRAFT", number: null })} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Discard this draft?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeDisabled();
    expect(screen.getByText(/no number, no stock and no account entry/)).toBeInTheDocument();
  });

  it("a refusal because money was received is shown verbatim and lists the receipts, each with a link", async () => {
    const message = "Money has been received against this invoice (REC-2026-000031 — PKR 4,000). Reverse the receipt first, then cancel the invoice.";
    mockApi({ [`POST /invoices/${IDS.invoice}/cancel`]: respond(422, { message, errors: [message] }) });
    const user = userEvent.setup();
    wrap(<CancelInvoiceDialog invoice={invoiceDetail({ receipts: [receipt], paidP: 400_000 })} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText("Reason"), "wrong shop");
    await user.click(screen.getByRole("button", { name: "Cancel invoice" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    const list = screen.getByTestId("receipt-links");
    const link = within(list).getByRole("link", { name: "REC-2026-000031" });
    expect(link).toHaveAttribute("href", `/payments/${IDS.receipt}`);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a double click sends one request", async () => {
    const { calls } = mockApi({ [`POST /invoices/${IDS.invoice}/cancel`]: async () => { await new Promise((r) => setTimeout(r, 30)); return { body: invoiceDetail({ status: "CANCELLED" }) }; } });
    const user = userEvent.setup();
    wrap(<CancelInvoiceDialog invoice={invoiceDetail()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText("Reason"), "x");
    const b = screen.getByRole("button", { name: "Cancel invoice" });
    await user.dblClick(b);
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

function shopRoutes(extra: Record<string, unknown> = {}) {
  return {
    "GET /regions": [],
    "GET /customers": [SHOP, OTHER],
    [`GET /customers/${IDS.shop}/balance`]: { partyId: IDS.shop, balanceP: 3_500_000 },
    [`GET /customers/${IDS.other}/balance`]: { partyId: IDS.other, balanceP: 200_000 },
    ...extra,
  };
}
async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Correct shop" }));
  await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

describe("Change shop", () => {
  it("starts on a blank choice (never pre-selected), Move invoice is off, and the old shop's before → after is drawn", async () => {
    mockApi(shopRoutes());
    wrap(<ChangeShopPanel invoice={invoiceDetail({ totalP: 1_000_000 })} onClose={vi.fn()} />);
    const combo = screen.getByRole("combobox", { name: "Correct shop" });
    expect(combo).toHaveValue("");
    expect(screen.getByRole("button", { name: "Move invoice" })).toBeDisabled();
    expect(screen.getByText("Choose a shop to see how its balance changes.")).toBeInTheDocument();
    expect(await screen.findByTestId("cs-old-now")).toHaveTextContent("PKR 35,000.00");
    expect(screen.getByTestId("cs-old-after")).toHaveTextContent("PKR 25,000.00"); // 35,000 − the invoice's 10,000
  });

  it("choosing a different shop shows its balance now → after and enables the move", async () => {
    mockApi(shopRoutes());
    const user = userEvent.setup();
    wrap(<ChangeShopPanel invoice={invoiceDetail({ totalP: 1_000_000 })} onClose={vi.fn()} />);
    await choose(user, "Beta");
    expect(await screen.findByTestId("cs-new-now")).toHaveTextContent("PKR 2,000.00");
    expect(screen.getByTestId("cs-new-after")).toHaveTextContent("PKR 12,000.00");
    expect(screen.getByRole("button", { name: "Move invoice" })).toBeEnabled();
  });

  it("the receipts that move with the invoice are named, and only the unpaid part changes the balances", async () => {
    mockApi(shopRoutes());
    const user = userEvent.setup();
    wrap(<ChangeShopPanel invoice={invoiceDetail({ totalP: 1_000_000, receipts: [receipt] })} onClose={vi.fn()} />);
    expect(screen.getByTestId("cs-moving")).toHaveTextContent("REC-2026-000031 (PKR 4,000.00)");
    await choose(user, "Beta");
    expect(await screen.findByTestId("cs-new-after")).toHaveTextContent("PKR 8,000.00"); // 2,000 + (10,000 − 4,000)
    expect(screen.getByTestId("cs-old-after")).toHaveTextContent("PKR 29,000.00"); // 35,000 − 6,000
  });

  it("the shop the invoice already belongs to is refused (Save stays off) with the reason", async () => {
    mockApi(shopRoutes());
    const user = userEvent.setup();
    wrap(<ChangeShopPanel invoice={invoiceDetail()} onClose={vi.fn()} />);
    await choose(user, "Alpha");
    expect(screen.getByText("That is already the shop on this invoice.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move invoice" })).toBeDisabled();
  });

  it("Move sends the chosen shop and the reason; the server's refusal is shown verbatim and nothing closes", async () => {
    const refusal = "Receipt REC-2026-000031 (PKR 4,000) was also applied to other invoices or left partly on account, so it belongs to the shop, not to this one invoice.";
    const { calls } = mockApi(shopRoutes({ [`POST /invoices/${IDS.invoice}/change-shop`]: respond(422, { message: refusal, errors: [refusal] }) }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<ChangeShopPanel invoice={invoiceDetail()} onClose={onClose} />);
    await choose(user, "Beta");
    await user.type(screen.getByLabelText("Reason (optional)"), "picked the wrong shop");
    await user.click(screen.getByRole("button", { name: "Move invoice" }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ customerId: IDS.other, reason: "picked the wrong shop" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a successful move closes the panel", async () => {
    mockApi(shopRoutes({ [`POST /invoices/${IDS.invoice}/change-shop`]: invoiceDetail({ customerId: IDS.other, shop: { ...invoiceDetail().shop, shopName: "Beta Traders", name: "Beta Traders" } }) }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<ChangeShopPanel invoice={invoiceDetail()} onClose={onClose} />);
    await choose(user, "Beta");
    await user.click(screen.getByRole("button", { name: "Move invoice" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("Post invoice (a saved draft, straight from its page)", () => {
  const draft = () => invoiceDetail({ status: "DRAFT", number: null, revision: 3, stockApplied: false, stockMovements: [], paidP: 0 });

  it("states what posting does first, then sends ONE PUT built from the draft: mode post, paid 0, the revision as loaded, its line ids, a key", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockApi({ [`PUT /invoices/${IDS.invoice}`]: async () => (await gate, { status: 200, body: invoiceDetail() }) });
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<PostDraftDialog invoice={draft()} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "Post this invoice?" })).toBeInTheDocument();
    expect(screen.getByText(/given its own invoice number/)).toBeInTheDocument();
    expect(screen.getByText(/bags leave stock \(30 in all/)).toBeInTheDocument();
    expect(screen.getByText(/balance goes up by PKR 27,425.00/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    const confirm = screen.getByTestId("confirm-post");
    await user.click(confirm);
    await user.click(confirm); // a second click while it is on its way
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ mode: "post", paidAmountP: 0, revision: 3, customerId: IDS.shop, lines: [{ id: IDS.line }, { id: IDS.line2 }] });
    expect((puts[0]!.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });

  it("a refusal (stock, a missing rate) is shown verbatim and the dialog stays open", async () => {
    const refusal = "Only 10 bags of Zam Zam Atta 20KG are available in Main Godown. Requested: 20.";
    mockApi({ [`PUT /invoices/${IDS.invoice}`]: respond(422, { message: refusal, errors: [refusal] }) });
    const onClose = vi.fn();
    const user = userEvent.setup();
    wrap(<PostDraftDialog invoice={draft()} onClose={onClose} />);
    await user.click(screen.getByTestId("confirm-post"));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.getByText("This invoice cannot be posted yet — nothing has been changed")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-post")).toBeEnabled();
  });
});
