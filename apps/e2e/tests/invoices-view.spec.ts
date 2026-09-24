import type { Page } from "@playwright/test";
import type { InvoiceDetail, Role } from "@farooq/shared";
import { test, expect, apiAs, allInvoices, invoiceDetailOf, paisaOf, type Api } from "./fixtures";

/** The view page for each status, the actions drawn from the server's verdict, profit visibility per role, and the statement / Receive-panel additions. */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

const money = (p: number) => `${(p / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One invoice of the given stored status that has lines (except a draft/cancelled that may have any). */
async function pick(status: string, filter: (d: InvoiceDetail) => boolean = () => true): Promise<InvoiceDetail> {
  for (const item of await allInvoices(api, `status=${status}`)) {
    const d = await invoiceDetailOf(api, item.id);
    if (d.lines.length > 0 && filter(d)) return d;
  }
  throw new Error(`No ${status} invoice with lines in the dataset`);
}

async function figures(page: Page) {
  return {
    grand: paisaOf(await page.getByTestId("grand-total").innerText()),
    paid: (await page.getByTestId("paid-total").count()) ? paisaOf(await page.getByTestId("paid-total").innerText()) : null,
    balance: (await page.getByTestId("balance-total").count()) ? paisaOf(await page.getByTestId("balance-total").innerText()) : null,
  };
}

const STATUSES: { status: string; label: string; filter?: (d: InvoiceDetail) => boolean }[] = [
  { status: "DRAFT", label: "Draft" },
  { status: "CONFIRMED", label: "Confirmed" },
  { status: "PARTIALLY_PAID", label: "Partly paid" },
  { status: "PAID", label: "Paid" },
  { status: "CANCELLED", label: "Cancelled", filter: (d) => d.number !== null },
  { status: "DISPATCHED", label: "Dispatched" },
  { status: "PARTIALLY_RETURNED", label: "Partly returned" },
];

for (const { status, label, filter } of STATUSES) {
  test(`view page — ${status}: every figure is the API's; lines, receipts, banners and the server's action verdicts`, async ({ open }) => {
    const { page } = await open("OWNER");
    const d = await pick(status, filter);
    await page.goto(`/invoices/${d.id}`);
    await expect(page.getByTestId("invoice-number")).toHaveText(d.number ?? "Draft");
    await expect(page.getByTestId("invoice-status")).toHaveText(label);
    await expect(page.getByTestId("invoice-shop")).toHaveText(d.shop.shopName ?? d.shop.name ?? "");

    const f = await figures(page);
    expect(f.grand).toBe(d.totalP);
    if (status === "DRAFT" || status === "CANCELLED") {
      expect(f.paid).toBeNull(); // nothing to collect on these
    } else {
      expect(f.paid).toBe(d.paidP);
      expect(f.balance).toBe(d.outstandingP);
    }
    await expect(page.getByTestId("line-row")).toHaveCount(d.lines.length);
    await expect(page.getByTestId("receipt-row")).toHaveCount(d.receipts.length);
    await expect(page.getByTestId("stock-row")).toHaveCount(d.stockMovements.length);
    if (status === "DRAFT") {
      await expect(page.getByTestId("draft-banner")).toBeVisible();
      expect(d.stockMovements).toHaveLength(0);
      await expect(page.getByTestId("no-stock")).toContainText("A draft moves no stock.");
    }
    if (status === "CANCELLED") {
      await expect(page.getByTestId("cancelled-banner")).toContainText(d.cancelReason ?? "");
      await expect(page.getByTestId("invoice-number")).toHaveClass(/line-through/);
    }
    // the quantity of every stock row is the API's
    const qtys = await page.getByTestId("stock-qty").allInnerTexts();
    expect(qtys.map((q) => Number(q.replace("+", "")))).toEqual(d.stockMovements.map((m) => m.quantity));

    // actions: enabled exactly as the server says, the reason under a disabled button is the server's own words
    const verdict = { cancel: d.actions.cancel, "change-shop": d.actions.changeShop, duplicate: d.actions.duplicate };
    for (const [testId, a] of Object.entries(verdict)) {
      const btn = page.getByTestId(`action-${testId}`);
      if (testId === "change-shop" && status === "DRAFT") {
        await expect(btn).toHaveCount(0); // a draft has no account entry to move — edit-and-pick is S10
        continue;
      }
      await expect(btn, testId).toBeVisible();
      if (a.allowed) await expect(btn, testId).toBeEnabled();
      else {
        await expect(btn, testId).toBeDisabled();
        await expect(page.getByTestId(`reason-${testId}`)).toHaveText(a.reason!);
      }
    }
    // nothing on the page offers to edit (the builder is S10)
    await expect(page.getByRole("button", { name: /^edit/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^edit/i })).toHaveCount(0);
  });
}

test("a paid or part-paid invoice: cancel is off with the server's reason, and the receipts are listed with links to their vouchers", async ({ open }) => {
  const { page } = await open("OWNER");
  const d = await pick("PARTIALLY_PAID", (x) => x.receipts.some((r) => r.status === "POSTED"));
  await page.goto(`/invoices/${d.id}`);
  await expect(page.getByTestId("action-cancel")).toBeDisabled();
  await expect(page.getByTestId("reason-cancel")).toContainText("Money has been received against this invoice");
  const posted = d.receipts.filter((r) => r.status === "POSTED");
  const links = page.getByTestId("receipt-links");
  for (const r of posted) await expect(links.getByRole("link", { name: r.receiptNumber })).toHaveAttribute("href", `/payments/${r.paymentId}`);
  await links.getByRole("link", { name: posted[0]!.receiptNumber }).click();
  await expect(page).toHaveURL(new RegExp(`/payments/${posted[0]!.paymentId}$`));
  await expect(page.getByTestId("voucher-number")).toHaveText(posted[0]!.receiptNumber);
});

test("a reversed receipt is shown struck and marked, and is not counted in 'Received'", async ({ open }) => {
  const { page } = await open("OWNER");
  const d = await pick("CONFIRMED", (x) => x.receipts.some((r) => r.status === "REVERSED")).catch(() => pick("PARTIALLY_PAID", (x) => x.receipts.some((r) => r.status === "REVERSED")));
  await page.goto(`/invoices/${d.id}`);
  const reversed = d.receipts.find((r) => r.status === "REVERSED")!;
  const row = page.getByTestId("receipt-row").filter({ hasText: reversed.receiptNumber });
  await expect(row).toContainText("Reversed");
  const f = await figures(page);
  expect(f.paid).toBe(d.paidP);
  expect(d.paidP).toBe(d.receipts.filter((r) => r.status === "POSTED").reduce((a, r) => a + r.allocatedP, 0));
});

test("an unknown invoice says so; a bad address does not break the screen", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the browser logs the 404 this test provokes on purpose
  const { page } = await open("OWNER");
  await page.goto("/invoices/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Invoice not found")).toBeVisible();
  await page.goto("/invoices?page=-3&sort=hax&status=DROP&scope=<b>");
  await expect(page.getByTestId("invoice-row").first()).toBeVisible();
});

/* ── profit: shown for the roles that hold PROFIT_VIEW, absent from the page (not hidden) for the rest ── */

test("profit: OWNER / MANAGER / ACCOUNTANT see the block with the API's numbers and 'cost unknown' where there is no cost; SALES has no profit anywhere in the DOM", async ({ open }) => {
  const withUnknown = await (async () => {
    for (const item of await allInvoices(api, "status=CONFIRMED")) {
      const d = await invoiceDetailOf(api, item.id);
      if (d.profit && !d.profit.complete && d.profit.unknownCostLines > 0 && d.profit.profitP !== null) return d;
    }
    throw new Error("no invoice with a line of unknown cost");
  })();
  const p = withUnknown.profit!;
  for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as Role[]) {
    const { page } = await open(role);
    await page.goto(`/invoices/${withUnknown.id}`);
    const block = page.getByTestId("profit-block");
    await expect(block).toBeVisible();
    await expect(page.getByTestId("profit-total")).toContainText(money(p.profitP!));
    await expect(page.getByTestId("profit-incomplete")).toContainText(`Cost unknown on ${p.unknownCostLines} line`);
    const cells = await page.getByTestId("line-profit").allInnerTexts();
    expect(cells).toHaveLength(withUnknown.lines.length);
    expect(cells.filter((c) => c === "cost unknown")).toHaveLength(p.lines.filter((l) => !l.costKnown).length);
    for (const c of cells) expect(c).not.toMatch(/^(PKR )?0(\.00)?$/); // never "0" for an unknown cost
  }
  // the API never sends it to SALES, and the screen has no trace of it
  const sales = await apiAs("SALES");
  const asSales = await invoiceDetailOf(sales, withUnknown.id);
  expect("profit" in asSales).toBe(false);
  const { page } = await open("SALES");
  await page.goto(`/invoices/${withUnknown.id}`);
  await expect(page.getByTestId("invoice-number")).toBeVisible();
  await expect(page.getByTestId("profit-block")).toHaveCount(0);
  await expect(page.getByTestId("line-profit")).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toMatch(/profit|margin|cost unknown/i);
  // phone cards too
  const phone = await open("SALES", { width: 390, height: 844 });
  await phone.page.goto(`/invoices/${withUnknown.id}`);
  await expect(phone.page.getByTestId("line-cards")).toBeVisible();
  expect(await phone.page.content()).not.toMatch(/profit|margin|cost unknown/i);
});

/* ── statements and the Receive panel (additive S8 fields) ── */

test("statement: an invoice row's Description is what the invoice was for, Qty is its bags; payment rows say '—' — screen equals the API", async ({ open }) => {
  const { page } = await open("OWNER");
  const d = await pick("CONFIRMED", (x) => x.lines.length >= 2 && x.customerId !== null);
  const st = await api.get<import("@farooq/shared").Statement>(`/customers/${d.customerId}/statement`);
  const row = st.rows.find((r) => r.ref === d.number)!;
  expect(row.detail).toBeTruthy();
  expect(row.qtyLabel).not.toBe("—");
  await page.goto(`/statements?type=customer&partyId=${d.customerId}`);
  const screenRow = page.getByTestId("statement-row").filter({ hasText: d.number! });
  await expect(screenRow.getByTestId("statement-description")).toHaveText(row.detail!);
  await expect(screenRow.getByTestId("statement-qty")).toHaveText(row.qtyLabel);
  const other = st.rows.find((r) => r.detail === null);
  if (other) {
    const orow = page.getByTestId("statement-row").filter({ hasText: other.ref }).first();
    await expect(orow.getByTestId("statement-qty")).toHaveText("—");
  }
  // the phone entry card carries the detail line and the quantity
  const phone = await open("OWNER", { width: 390, height: 844 });
  await phone.page.goto(`/statements?type=customer&partyId=${d.customerId}`);
  const card = phone.page.getByTestId("statement-cards").locator("li").filter({ hasText: d.number! });
  await expect(card).toContainText(row.detail!);
  await expect(card).toContainText(`Qty ${row.qtyLabel}`);
});

test("Receive panel: each outstanding invoice says what it was for (the server's line summary)", async ({ open }) => {
  const { page } = await open("OWNER");
  // a shop with an unpaid invoice that has lines
  const shops = await api.get<{ id: string; name: string }[]>("/customers?limit=100");
  let shopName = "";
  let expected: { number: string | null; lineSummary: string } | undefined;
  for (const item of await allInvoices(api, "status=CONFIRMED")) {
    if (!item.customerId || item.itemCount === 0) continue;
    const outstanding = await api.get<{ number: string | null; lineSummary: string; outstandingP: number }[]>(`/customers/${item.customerId}/outstanding-invoices`);
    const hit = outstanding.find((o) => o.lineSummary && o.outstandingP > 0);
    if (hit) {
      shopName = shops.find((s) => s.id === item.customerId)!.name;
      expected = hit;
      break;
    }
  }
  expect(expected, "a shop with a summarised outstanding invoice").toBeTruthy();
  await page.goto("/payments?panel=receive");
  const dlg = page.getByRole("dialog");
  const combo = dlg.getByRole("combobox", { name: "Shop" });
  await combo.click();
  await combo.fill(shopName);
  await dlg.getByRole("option", { name: new RegExp(shopName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
  const row = dlg.getByTestId("alloc-row").filter({ hasText: expected!.number! });
  await expect(row.getByTestId("alloc-summary")).toHaveText(expected!.lineSummary);
});
