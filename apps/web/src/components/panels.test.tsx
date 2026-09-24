import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockApi, respond } from "../test/fetch-mock";

// The panel navigates to the receipt after a save; there is no router in a component test.
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

import { PaymentPanel } from "./payment-panels";
import { ToastProvider } from "./ui";

const SHOP = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha Store", contact: "Noor", phone: "0300-1", region: "Drosh", regionId: null, active: true };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "گاما ٹریڈرز", contact: null, phone: null, region: null, regionId: null, active: true };
const invoice = (n: number, outstandingP: number) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
  number: `INV-${n}`,
  date: `2026-08-0${n}`,
  status: "CONFIRMED",
  totalP: outstandingP,
  paidP: 0,
  creditP: 0,
  outstandingP,
});
const VOUCHER = {
  id: "99999999-9999-4999-8999-999999999999", receiptNumber: "REC-2026-000001", direction: "IN", partyType: "CUSTOMER", partyId: SHOP.id, partyName: SHOP.name,
  kind: "received", partyNameSnapshot: SHOP.name, partyOwnerSnapshot: null, regionSnapshot: null, isRefund: false, amountP: 100_000, method: "Cash", reference: null,
  note: null, paymentDate: "2026-09-24", status: "POSTED", receivedBy: "T", createdAt: "2026-09-24T05:00:00.000Z", createdBy: null, reversedAt: null,
  reversedBy: null, reverseReason: null, allocatedP: 0, unallocatedP: 100_000,
};

function routes(extra: Record<string, unknown> = {}) {
  return {
    "GET /regions": [],
    "GET /customers": [SHOP, OTHER],
    "GET /suppliers": [{ ...SHOP, id: "33333333-3333-4333-8333-333333333333", name: "Mills" }],
    [`GET /customers/${SHOP.id}/balance`]: { partyId: SHOP.id, balanceP: 600_000 },
    [`GET /customers/${SHOP.id}/outstanding-invoices`]: [invoice(1, 100_000), invoice(2, 200_000), invoice(3, 300_000)],
    ...extra,
  };
}

function renderPanel(mode: "receive" | "pay" | "refund" = "receive") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PaymentPanel mode={mode} onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

async function chooseShop(user: ReturnType<typeof userEvent.setup>, name = "Alpha Store") {
  const combo = screen.getByRole("combobox", { name: "Shop" });
  await user.click(combo);
  await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

beforeEach(() => navigate.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("money panels never pre-select a party", () => {
  it("Receive starts on '— Choose a shop —' and Save is off", () => {
    mockApi(routes());
    renderPanel("receive");
    const combo = screen.getByRole("combobox", { name: "Shop" });
    expect(combo).toHaveValue("");
    expect(combo).toHaveAttribute("placeholder", "— Choose a shop —");
    expect(screen.getByRole("button", { name: /Record payment/ })).toBeDisabled();
  });

  it("Pay supplier starts on '— Choose a supplier —'; Pay a shop on '— Choose a shop —'", () => {
    mockApi(routes());
    const { unmount } = renderPanel("pay") as unknown as { unmount?: () => void };
    expect(screen.getByRole("combobox", { name: "Supplier" })).toHaveAttribute("placeholder", "— Choose a supplier —");
    unmount?.();
  });

  it("Pay a shop starts unchosen too", () => {
    mockApi(routes());
    renderPanel("refund");
    expect(screen.getByRole("combobox", { name: "Shop" })).toHaveValue("");
    expect(screen.getByRole("button", { name: /Record payment/ })).toBeDisabled();
  });

  it("Save stays disabled until BOTH a party and a valid amount exist", async () => {
    mockApi(routes());
    const user = userEvent.setup();
    renderPanel();
    const save = screen.getByRole("button", { name: /Record payment/ });
    await user.type(screen.getByLabelText("Amount received"), "500");
    expect(save).toBeDisabled(); // amount but no shop
    await chooseShop(user);
    expect(save).toBeEnabled();
    await user.clear(screen.getByLabelText("Amount received"));
    expect(save).toBeDisabled(); // shop but no amount
    await user.type(screen.getByLabelText("Amount received"), "0");
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText("Amount received"));
    await user.type(screen.getByLabelText("Amount received"), "12.345");
    expect(save).toBeDisabled();
    expect(await screen.findByText(/at most 2 decimal/i)).toBeInTheDocument();
  });

  it("typing in the shop box un-chooses the shop, so Save cannot post to a stale party", async () => {
    mockApi(routes());
    const user = userEvent.setup();
    renderPanel();
    await chooseShop(user);
    await user.type(screen.getByLabelText("Amount received"), "100");
    expect(screen.getByRole("button", { name: /Record payment/ })).toBeEnabled();
    await user.type(screen.getByRole("combobox", { name: "Shop" }), "x");
    expect(screen.getByRole("button", { name: /Record payment/ })).toBeDisabled();
  });
});

describe("Receive: allocation preview", () => {
  it("shows the balance and previews the oldest-first split live", async () => {
    mockApi(routes());
    const user = userEvent.setup();
    renderPanel();
    await chooseShop(user);
    expect(await screen.findByText(/Shop owes us PKR 6,000.00/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Amount received"), "2,500");
    const preview = await screen.findAllByTestId("alloc-preview");
    expect(preview.map((p) => p.textContent)).toEqual(["1,000.00", "1,500.00", "—"]);
    expect(screen.getByTestId("left-over")).toHaveTextContent("0.00");
    await user.clear(screen.getByLabelText("Amount received"));
    await user.type(screen.getByLabelText("Amount received"), "7,000");
    expect(screen.getByTestId("left-over")).toHaveTextContent("1,000.00");
  });

  it("manual mode caps each box at its outstanding and needs at least one amount (an empty list would silently mean 'automatic')", async () => {
    mockApi(routes());
    const user = userEvent.setup();
    renderPanel();
    await chooseShop(user);
    await user.type(screen.getByLabelText("Amount received"), "3,000");
    await user.click(screen.getByLabelText("Choose amounts"));
    const save = screen.getByRole("button", { name: /Record payment/ });
    expect(save).toBeDisabled(); // nothing entered against any invoice
    await user.type(screen.getByLabelText("Amount to apply to INV-1"), "1,500");
    expect(await screen.findByText(/More than the 1,000 outstanding/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText("Amount to apply to INV-1"));
    await user.type(screen.getByLabelText("Amount to apply to INV-1"), "1,000");
    expect(save).toBeEnabled();
    await user.type(screen.getByLabelText("Amount to apply to INV-3"), "2,500");
    expect(await screen.findByText(/add up to 3,500, more than the 3,000 received/)).toBeInTheDocument();
    expect(save).toBeDisabled();
  });
});

describe("Save", () => {
  it("double-click posts exactly once, with an idempotency key, and goes to the receipt", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockApi(
      routes({
        "POST /payments/receive": async () => {
          await gate;
          return { status: 201, body: VOUCHER };
        },
      }),
    );
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    await chooseShop(user);
    await user.type(screen.getByLabelText("Amount received"), "1,000");
    const save = screen.getByRole("button", { name: /Record payment/ });
    await user.dblClick(save);
    release?.();
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ customerId: SHOP.id, amountP: 100_000, method: "Cash" });
    expect((posts[0]!.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    // automatic allocation sends NO allocations (the server allocates); manual sends them
    expect(posts[0]!.body).not.toHaveProperty("allocations");
    expect(navigate).toHaveBeenCalledWith({ to: "/payments/$id/receipt", params: { id: VOUCHER.id } });
    expect(onClose).toHaveBeenCalled();
  });

  it("manual mode sends the chosen invoice ids in paisa", async () => {
    const { calls } = mockApi(routes({ "POST /payments/receive": respond(201, VOUCHER) }));
    const user = userEvent.setup();
    renderPanel();
    await chooseShop(user);
    await user.type(screen.getByLabelText("Amount received"), "1,500");
    await user.click(screen.getByLabelText("Choose amounts"));
    await user.type(screen.getByLabelText("Amount to apply to INV-2"), "1,500");
    await user.click(screen.getByRole("button", { name: /Record payment/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const body = calls.find((c) => c.method === "POST")!.body as { allocations: unknown[] };
    expect(body.allocations).toEqual([{ invoiceId: "aaaaaaaa-0000-4000-8000-000000000002", amountP: 150_000 }]);
  });

  it("shows EVERY line of a 422 verbatim and keeps the form open; the next attempt is allowed", async () => {
    const { calls } = mockApi(
      routes({
        "POST /payments/receive": respond(422, { message: "Payment refused", errors: ["Invoice INV-1: Rs 1,500 is more than the Rs 1,000 outstanding.", "The allocations total Rs 1,500, more than the Rs 1,000 received."] }),
      }),
    );
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    await chooseShop(user);
    await user.type(screen.getByLabelText("Amount received"), "1,000");
    await user.click(screen.getByRole("button", { name: /Record payment/ }));
    const alert = await screen.findByTestId("error-lines");
    expect(alert).toHaveTextContent("Invoice INV-1: Rs 1,500 is more than the Rs 1,000 outstanding.");
    expect(alert).toHaveTextContent("The allocations total Rs 1,500, more than the Rs 1,000 received.");
    expect(onClose).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Record payment/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
  });

  it("a shop refund states the balance it will leave, and never blocks on it", async () => {
    const { calls } = mockApi(routes({ "POST /payments/refund": respond(201, { ...VOUCHER, direction: "OUT", kind: "paidToShops" }) }));
    const user = userEvent.setup();
    renderPanel("refund");
    await chooseShop(user);
    await user.type(screen.getByLabelText("Amount paid"), "1,000");
    expect(await screen.findByTestId("refund-confirmation")).toHaveTextContent("Shop owes us PKR 7,000.00");
    await user.click(screen.getByRole("button", { name: /Record payment/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.find((c) => c.path === "/payments/refund")!.body).toMatchObject({ customerId: SHOP.id, amountP: 100_000 });
  });

  it("an Urdu shop name is offered and chosen like any other", async () => {
    mockApi(routes({ [`GET /customers/${OTHER.id}/balance`]: { partyId: OTHER.id, balanceP: 0 }, [`GET /customers/${OTHER.id}/outstanding-invoices`]: [] }));
    const user = userEvent.setup();
    renderPanel();
    await chooseShop(user, "گاما");
    expect(screen.getByRole("combobox", { name: "Shop" })).toHaveValue("گاما ٹریڈرز");
    expect(screen.getByRole("combobox", { name: "Shop" })).toHaveAttribute("dir", "auto");
    expect(await screen.findByTestId("no-outstanding")).toBeInTheDocument();
  });
});
