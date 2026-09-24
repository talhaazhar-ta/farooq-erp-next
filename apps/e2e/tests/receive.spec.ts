import type { Page } from "@playwright/test";
import { test, expect, apiAs, balanceOf, findParty, paymentDetail, paymentsList, paisaOf, RECEIPT_NO, SCENARIO, type Api } from "./fixtures";

/**
 * The money panels, end to end: Receive (auto and manual allocation), Pay supplier, Pay a shop. Each test that moves money
 * uses its own shop from the e2e dataset (see setup/dataset.ts), so the order of tests never matters.
 */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });

async function choose(dlg: ReturnType<typeof dialog>, label: "Shop" | "Supplier", name: string) {
  const combo = dlg.getByRole("combobox", { name: label });
  await combo.click();
  await combo.fill(name);
  await dlg.getByRole("option", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await expect(combo).toHaveValue(name);
}

async function openReceive(page: Page) {
  await page.goto("/payments");
  await page.getByRole("button", { name: "Receive payment" }).click();
  const dlg = dialog(page, "Receive payment");
  await expect(dlg).toBeVisible();
  return dlg;
}

test("nothing is pre-selected; Save is refused until a shop AND a valid amount exist", async ({ open }) => {
  const { page } = await open("OWNER");
  const dlg = await openReceive(page);
  const combo = dlg.getByRole("combobox", { name: "Shop" });
  await expect(combo).toHaveValue("");
  await expect(combo).toHaveAttribute("placeholder", "— Choose a shop —");
  const save = dlg.getByRole("button", { name: /Record payment/ });
  await expect(save).toBeDisabled();
  await dlg.getByLabel("Amount received").fill("1,000");
  await expect(save).toBeDisabled(); // an amount without a shop
  await choose(dlg, "Shop", SCENARIO.delta.name);
  await expect(save).toBeEnabled();
  await dlg.getByLabel("Amount received").fill("12.345");
  await expect(save).toBeDisabled();
  await expect(dlg).toContainText("at most 2 decimal");
  await dlg.getByLabel("Amount received").fill("۱٬۰۰۰".replace("٬", ",")); // Urdu digits are accepted
  await expect(save).toBeEnabled();
  await page.keyboard.press("Escape"); // Esc closes the dialog
  await expect(dlg).toBeHidden();
  await expect(page).not.toHaveURL(/panel=/);
});

test("Receive with automatic allocation: the preview is what the server did, the receipt shows it, and the statement balance drops by the amount", async ({ open }) => {
  const { page } = await open("OWNER");
  const alpha = await findParty(api, "customers", SCENARIO.alpha.name);
  const before = await balanceOf(api, "customers", alpha.id);
  expect(before).toBe(6_000_000);

  const dlg = await openReceive(page);
  await choose(dlg, "Shop", SCENARIO.alpha.name);
  await expect(dlg.getByTestId("party-balance")).toContainText("Shop owes us PKR 60,000.00");
  await dlg.getByLabel("Amount received").fill("25,000");
  await dlg.getByLabel("Reference").fill("CHQ-E2E-AUTO");
  await dlg.getByLabel("Method").selectOption("Cheque");
  const preview = await dlg.getByTestId("alloc-preview").allInnerTexts();
  expect(preview).toEqual(["10,000.00", "15,000.00", "—"]);
  await expect(dlg.getByTestId("left-over")).toHaveText("0.00");
  await dlg.getByRole("button", { name: /Record payment/ }).click();

  // straight to the receipt
  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}\/receipt$/);
  const number = (await page.getByTestId("receipt-number").innerText()).trim();
  expect(number).toMatch(/^REC-2026-\d{6}$/);
  await expect(page.getByTestId("receipt-title")).toHaveText("PAYMENT RECEIPT");
  await expect(page.getByTestId("receipt-amount")).toHaveText("PKR 25,000.00");
  await expect(page.getByTestId("receipt-words")).toHaveText("Twenty Five Thousand Rupees Only");
  await expect(page.getByTestId("receipt-prev")).toHaveText("PKR 60,000.00");
  await expect(page.getByTestId("receipt-remaining")).toHaveText("PKR 35,000.00");
  const applied = await page.getByTestId("receipt-allocations").locator("tbody tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim())));
  expect(applied[0]![3]).toBe("10,000.00");
  expect(applied[1]![3]).toBe("15,000.00");
  expect(applied[2]![0]).toContain("Total applied");

  // what the server recorded is what the preview said
  const id = page.url().split("/").slice(-2, -1)[0]!;
  const detail = await paymentDetail(api, id);
  expect(detail.receiptNumber).toBe(number);
  expect(detail.allocations.map((a) => a.amountP)).toEqual([1_000_000, 1_500_000]);
  expect(detail.method).toBe("Cheque");
  expect(detail.reference).toBe("CHQ-E2E-AUTO");
  expect(await balanceOf(api, "customers", alpha.id)).toBe(before - 2_500_000);

  // the statement, reached from the receipt, says the same
  await page.getByRole("link", { name: "View statement" }).click();
  await expect(page).toHaveURL(/\/statements\?/);
  await expect(page.getByTestId("statement-party")).toHaveText(SCENARIO.alpha.name);
  await expect(page.getByTestId("statement-closing")).toContainText("PKR 35,000.00 — Shop owes us PKR 35,000.00");
  await expect(page.getByTestId("statement-table")).toContainText(number);

  // and the list shows it at the top
  await page.goto("/payments");
  await expect(page.getByTestId("payment-row").first()).toHaveAttribute("data-number", number);
});

test("Receive with manual allocation: the UI caps each invoice, keeps the left-over on account", async ({ open }) => {
  const { page } = await open("OWNER");
  const beta = await findParty(api, "customers", SCENARIO.beta.name);
  const dlg = await openReceive(page);
  await choose(dlg, "Shop", SCENARIO.beta.name);
  await dlg.getByLabel("Amount received").fill("5,000");
  await dlg.getByLabel("Choose amounts").check({ force: true });
  const save = dlg.getByRole("button", { name: /Record payment/ });
  await expect(save).toBeDisabled(); // manual with nothing entered would silently become automatic

  const first = dlg.getByLabel(/Amount to apply to INV-2026-\d+/).first();
  await first.fill("5,000.01");
  await expect(dlg).toContainText("More than the 5,000 outstanding");
  await expect(save).toBeDisabled();
  await first.fill("1,000");
  await dlg.getByLabel(/Amount to apply to INV-2026-\d+/).nth(1).fill("3,000");
  await expect(dlg.getByTestId("left-over")).toHaveText("1,000.00");
  await expect(save).toBeEnabled();
  await dlg.getByLabel(/Amount to apply to INV-2026-\d+/).nth(1).fill("4,500"); // 1,000 + 4,500 > 5,000 received
  await expect(dlg).toContainText("more than the 5,000 received");
  await expect(save).toBeDisabled();
  await dlg.getByLabel(/Amount to apply to INV-2026-\d+/).nth(1).fill("3,000");
  await save.click();

  await expect(page).toHaveURL(/\/receipt$/);
  const id = page.url().split("/").slice(-2, -1)[0]!;
  const detail = await paymentDetail(api, id);
  expect(detail.allocations.map((a) => a.amountP).sort((a, b) => a - b)).toEqual([100_000, 300_000]);
  expect(detail.unallocatedP).toBe(100_000);
  expect(await balanceOf(api, "customers", beta.id)).toBe(1_000_000 - 500_000);
  await expect(page.getByTestId("receipt-allocations")).toContainText("1,000.00");
  await expect(page.getByTestId("receipt-allocations")).toContainText("3,000.00");
});

test("the server has the last word: an over-cap allocation sent to the API is refused with the reason, and the UI shows a refusal verbatim", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the refused request is logged by the browser
  const gamma = await findParty(api, "customers", SCENARIO.gamma.name);
  const invoices = await api.get<{ id: string; number: string; outstandingP: number }[]>(`/customers/${gamma.id}/outstanding-invoices`);
  const attempt = await api.post("/payments/receive", { customerId: gamma.id, amountP: 900_000, allocations: [{ invoiceId: invoices[0]!.id, amountP: 900_000 }] });
  expect(attempt.status).toBe(422);
  expect(attempt.body.errors.join(" ")).toMatch(/more than the .* outstanding/);
  expect(await balanceOf(api, "customers", gamma.id)).toBe(800_000); // nothing was posted

  const { page } = await open("OWNER");
  const lines = ["Invoice INV-2026-000001: Rs 9,000 is more than the Rs 8,000 outstanding.", "The allocations total Rs 9,000, more than the Rs 1,000 received."];
  await page.route("**/payments/receive", (route) => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ message: "Payment refused", errors: lines }) }));
  const dlg = await openReceive(page);
  await choose(dlg, "Shop", SCENARIO.gamma.name); // an Urdu shop name
  await dlg.getByLabel("Amount received").fill("1,000");
  await dlg.getByRole("button", { name: /Record payment/ }).click();
  const box = dlg.getByTestId("error-lines");
  for (const l of lines) await expect(box).toContainText(l); // every line, verbatim
  await expect(dlg).toBeVisible(); // nothing is lost: the form stays open
  await expect(dlg.getByLabel("Amount received")).toHaveValue("1,000");
});

test("double-clicking Save posts exactly one voucher", async ({ open }) => {
  const { page } = await open("OWNER");
  const delta = await findParty(api, "customers", SCENARIO.delta.name);
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/payments/receive")) posts.push(r.postData() ?? "");
  });
  // hold the answer back so the second click really lands while the first is in flight
  await page.route("**/payments/receive", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  const dlg = await openReceive(page);
  await choose(dlg, "Shop", SCENARIO.delta.name);
  await dlg.getByLabel("Amount received").fill("777");
  await dlg.getByRole("button", { name: /Record payment/ }).dblclick();
  await expect(page).toHaveURL(/\/receipt$/);
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]!).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const mine = await paymentsList(api, `partyType=CUSTOMER&partyId=${delta.id}&limit=50`);
  expect(mine.total).toBe(1);
  expect(await balanceOf(api, "customers", delta.id)).toBe(-77_700);
});

test("a repeated request with the same idempotency key returns the first voucher (a lost answer cannot double-post)", async () => {
  const echo = await findParty(api, "customers", SCENARIO.india.name);
  const key = `e2e-replay-${Date.now()}`;
  const first = await api.post("/payments/receive", { customerId: echo.id, amountP: 12_300, idempotencyKey: key });
  const again = await api.post("/payments/receive", { customerId: echo.id, amountP: 12_300, idempotencyKey: key });
  expect(first.status).toBe(201);
  expect(again.status).toBe(200);
  expect(again.body.id).toBe(first.body.id);
  expect((await paymentsList(api, `partyType=CUSTOMER&partyId=${echo.id}&limit=50`)).total).toBe(1);
});

test("the default date is the Karachi business date, whatever the browser's own time zone says", async ({ open }) => {
  // 2026-09-24 20:30 UTC = 01:30 on the 25th in Karachi, but still the 24th (16:30) in New York
  const { page } = await open("OWNER", { timezoneId: "America/New_York" });
  await page.clock.setFixedTime(new Date("2026-09-24T20:30:00Z"));
  const dlg = await openReceive(page);
  await expect(dlg.getByLabel("Date")).toHaveValue("2026-09-25");
});

test("Pay supplier: a numbered voucher, the supplier's balance drops, the statement shows it", async ({ open }) => {
  const { page } = await open("OWNER");
  const sup = await findParty(api, "suppliers", SCENARIO.supplier.name);
  const before = await balanceOf(api, "suppliers", sup.id);
  expect(before).toBe(5_000_000);

  await page.goto("/payments");
  await page.getByRole("button", { name: "Pay supplier" }).click();
  const dlg = dialog(page, "Pay supplier");
  await expect(dlg.getByRole("combobox", { name: "Supplier" })).toHaveAttribute("placeholder", "— Choose a supplier —");
  await choose(dlg, "Supplier", SCENARIO.supplier.name);
  await expect(dlg.getByTestId("party-balance")).toContainText("We owe supplier PKR 50,000.00");
  await dlg.getByLabel("Amount paid").fill("20,000");
  await dlg.getByLabel("Method").selectOption("Bank Transfer");
  await dlg.getByLabel("Reference").fill("TRX-E2E-1");
  await dlg.getByRole("button", { name: /Record payment/ }).click();

  await expect(page).toHaveURL(/\/receipt$/);
  await expect(page.getByTestId("receipt-title")).toHaveText("PAYMENT VOUCHER");
  expect((await page.getByTestId("receipt-number").innerText()).trim()).toMatch(/^PV-2026-\d{6}$/);
  await expect(page.getByTestId("receipt-party")).toHaveText(SCENARIO.supplier.name);
  await expect(page.getByTestId("receipt-amount")).toHaveText("PKR 20,000.00");
  await expect(page.getByTestId("receipt-remaining")).toHaveText("PKR 30,000.00");
  expect(await balanceOf(api, "suppliers", sup.id)).toBe(3_000_000);

  await page.getByRole("link", { name: "View statement" }).click();
  await expect(page.getByTestId("statement-table")).toContainText("Payment made — Bank Transfer");
  await expect(page.getByTestId("statement-closing")).toContainText("We owe supplier PKR 30,000.00");
});

test("Pay a shop (refund): says the balance it will leave, never blocks on it, posts a voucher", async ({ open }) => {
  const { page } = await open("OWNER");
  const echo = await findParty(api, "customers", SCENARIO.echo.name);
  await page.goto("/payments");
  await page.getByRole("button", { name: "Pay a shop" }).click();
  const dlg = dialog(page, "Pay a shop");
  await choose(dlg, "Shop", SCENARIO.echo.name);
  await dlg.getByLabel("Amount paid").fill("1,500");
  await expect(dlg.getByTestId("refund-confirmation")).toContainText("Shop owes us PKR 1,500.00");
  await dlg.getByRole("button", { name: /Record payment/ }).click();
  await expect(page).toHaveURL(/\/receipt$/);
  await expect(page.getByTestId("receipt-title")).toHaveText("PAYMENT VOUCHER");
  expect((await page.getByTestId("receipt-number").innerText()).trim()).toMatch(RECEIPT_NO);
  expect(await balanceOf(api, "customers", echo.id)).toBe(150_000);
  await page.goto("/payments?tab=paidToShops");
  await expect(page.getByTestId("payment-row").first()).toContainText(SCENARIO.echo.name);
});

test("SALES can receive a payment but is not offered any pay-out", async ({ open }) => {
  const { page } = await open("SALES");
  const shop = await findParty(api, "customers", SCENARIO.india.name);
  const before = await balanceOf(api, "customers", shop.id);
  await page.goto("/payments?panel=pay"); // even a hand-typed panel address gives no pay-out form
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const dlg = await openReceive(page);
  await choose(dlg, "Shop", SCENARIO.india.name);
  await dlg.getByLabel("Amount received").fill("1,000");
  await dlg.getByRole("button", { name: /Record payment/ }).click();
  await expect(page).toHaveURL(/\/receipt$/);
  expect(paisaOf(await page.getByTestId("receipt-amount").innerText())).toBe(100_000);
  expect(await balanceOf(api, "customers", shop.id)).toBe(before - 100_000);
  const detail = await paymentDetail(api, page.url().split("/").slice(-2, -1)[0]!);
  expect(detail.receivedBy).toContain("Sales");
});
