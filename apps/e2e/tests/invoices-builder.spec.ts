import type { InvoiceDetail, Region, Statement } from "@farooq/shared";
import { test, expect, allInvoices, apiAs, balanceOf, findParty, invoiceDetailOf, statementOf, SCENARIO, type Api } from "./fixtures";
import { addProduct, builderProduct, chooseShop, fillLine, godowns, netBags, saveViaApi, screenGrandTotal, stockOf } from "./builder-helpers";

/**
 * The invoice builder (S10) driven like a person, against the real server. Every figure a test expects is read back from the
 * API (stock, balance, statement, receipts) — the screen is never its own witness. Each test that moves money owns a shop of
 * its own (Papa … Yankee) so the full run stays deterministic.
 *
 *   Papa     draft → edit → post with payment            Victor   SALES builds and posts; ACCOUNTANT corrects
 *   Quebec   stock refusals, fixed and retried           Whiskey  live totals; duplicate → the editor
 *   Romeo    fractional bags, Urdu digits                Xray     post from the view page, discard from the editor
 *   Sierra   edit up and down, shop locked, cancel       Yankee   network failure, last rate, zero stock
 *   Tango    stale revision, Reload                      Uniform  double click
 */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

/** The invoices (any status) made for one shop. */
const invoicesOf = async (customerId: string) => (await allInvoices(api, "")).filter((i) => i.customerId === customerId);

test("new invoice → save a draft (many drafts may exist) → edit it → post with money taken: receipt, stock, statement and balance agree with the API", async ({ open }) => {
  const { page } = await open("OWNER");
  const papa = await findParty(api, "customers", SCENARIO.papa.name);
  const { main } = await godowns(api);
  const stock0 = await stockOf(api, "priced", main.id);

  // the button, the empty builder: the shop is NOT pre-selected
  await page.goto("/invoices");
  await page.getByTestId("new-invoice").click();
  await expect(page).toHaveURL(/\/invoices\/new$/);
  await expect(page.getByTestId("builder-title")).toHaveText("New invoice");
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveAttribute("placeholder", "— Choose a shop —");
  await expect(page.getByTestId("no-lines")).toBeVisible();

  // shop, then a product: the rate starts at the owner's set price, the quantity box has the focus
  await chooseShop(page, SCENARIO.papa.name);
  await expect(page.getByTestId("shop-card")).toContainText("Owner");
  await expect(page.getByTestId("shop-balance")).toContainText("Settled");
  const i = await addProduct(page, "Builder Priced");
  await expect(page.getByTestId("line-qty").nth(i)).toBeFocused();
  await expect(page.getByTestId("line-rate").nth(i)).toHaveValue("2000");
  await page.keyboard.type("10");
  await expect(page.getByTestId("line-amount").nth(i)).toHaveText("20,000.00");
  expect(await screenGrandTotal(page)).toBe(2_000_000);

  // save a DRAFT: no number, no stock, no balance
  await page.getByTestId("save-draft").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("toast").filter({ hasText: "Draft saved" }).first()).toBeVisible();
  const draftId = page.url().split("/").pop()!;
  let d = await invoiceDetailOf(api, draftId);
  expect(d.status).toBe("DRAFT");
  expect(d.number).toBeNull();
  expect(d.totalP).toBe(2_000_000);
  expect(d.customerId).toBe(papa.id);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0);
  expect(await balanceOf(api, "customers", papa.id)).toBe(0);

  // many drafts may exist for one shop
  const second = await saveViaApi(api, { customerId: papa.id, warehouseId: main.id, mode: "draft", lines: [{ productId: (await builderProduct(api, "priced", main.id)).id, quantity: 1, unitPriceP: 200_000 }] });
  expect(second.status).toBe("DRAFT");
  expect(second.id).not.toBe(draftId);

  // open the first draft's editor from its page: the lines came along
  await page.getByTestId("action-edit").click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${draftId}/edit$`));
  await expect(page.getByTestId("builder-title")).toHaveText("Edit draft");
  await expect(page.getByTestId("line-row")).toHaveCount(1);
  await expect(page.getByTestId("line-qty").first()).toHaveValue("10");
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(SCENARIO.papa.name);
  await fillLine(page, 0, "qty", "12");
  await page.getByTestId("field-paidAmount").fill("5,000");
  await expect(page.getByTestId("summary-balance")).toHaveText("PKR 19,000.00"); // 12 × 2,000 = 24,000 − 5,000
  await page.getByTestId("save-post").click();

  // posted: its own number, and the server did everything at once
  await expect(page).toHaveURL(new RegExp(`/invoices/${draftId}$`));
  // the toast is found by its text: the earlier "Draft saved" toast may still be on screen, so `.first()` alone read the wrong one (a flake seen once on S11)
  await expect(page.getByTestId("toast").filter({ hasText: "posted" }).first()).toBeVisible();
  d = await invoiceDetailOf(api, draftId);
  expect(d.number).toMatch(/^INV-\d{4}-\d{6}$/);
  expect(d.status).toBe("PARTIALLY_PAID");
  expect(d.totalP).toBe(2_400_000);
  expect(d.paidP).toBe(500_000);
  expect(d.receipts).toHaveLength(1);
  expect(d.receipts[0]!.allocatedP).toBe(500_000);
  await expect(page.getByTestId("invoice-number")).toHaveText(d.number!);
  await expect(page.getByTestId("paid-total")).toHaveText("5,000.00");
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 12);
  expect(await balanceOf(api, "customers", papa.id)).toBe(1_900_000);
  const st: Statement = await statementOf(api, "customers", papa.id);
  expect(st.rows.some((r) => r.kind === "INVOICE" && r.ref === d.number)).toBe(true);
  expect(st.closing).toBe(1_900_000);
  await expect(page.getByTestId("stock-row")).toHaveCount(d.stockMovements.length);
});

test("post refused for stock with the server's words → the form is kept → fix and retry works; two lines of one product are totalled against the stock", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the server refuses on purpose here; the browser logs every 422
  const { page } = await open("OWNER");
  const quebec = await findParty(api, "customers", SCENARIO.quebec.name);
  const { main, second } = await godowns(api);
  const tight0 = await stockOf(api, "tight", main.id);
  expect(tight0).toBe(10);

  await page.goto("/invoices/new");
  await chooseShop(page, SCENARIO.quebec.name);
  const i = await addProduct(page, "Builder Tight");
  await fillLine(page, i, "qty", "25");
  // the screen warns BEFORE saving (a warning, not a block) …
  await expect(page.getByTestId("line-avail").first()).toContainText("10 available · short by 15");
  await expect(page.getByTestId("short-count")).toHaveText("1 line short of stock");
  await expect(page.getByTestId("stock-warning")).toBeVisible();
  await expect(page.getByTestId("save-post")).toBeEnabled();
  // … and the server is the judge
  await page.getByTestId("save-post").click();
  await expect(page.getByTestId("save-errors")).toContainText(`Only 10 bags of Builder Tight Pulses 20KG are available in ${main.name}. Requested: 25.`);
  await expect(page).toHaveURL(/\/invoices\/new$/);
  await expect(page.getByTestId("line-qty").first()).toHaveValue("25"); // the form is exactly as typed
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(SCENARIO.quebec.name);
  expect(await stockOf(api, "tight", main.id)).toBe(10);
  expect(await balanceOf(api, "customers", quebec.id)).toBe(0);
  expect(await invoicesOf(quebec.id)).toHaveLength(0);

  // fix and retry
  await fillLine(page, i, "qty", "8");
  await expect(page.getByTestId("line-avail").first()).toHaveText("10 available");
  await expect(page.getByTestId("short-count")).toHaveCount(0);
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  expect(await stockOf(api, "tight", main.id)).toBe(2);
  expect(await balanceOf(api, "customers", quebec.id)).toBe(800_000);

  // two lines of one product from one godown: 6 + 6 against 10 — BOTH lines are marked, the server refuses the total
  await page.goto("/invoices/new");
  await chooseShop(page, SCENARIO.quebec.name);
  await page.getByTestId("header-warehouse").selectOption({ label: second.name });
  const a = await addProduct(page, "Builder Tight");
  await fillLine(page, a, "qty", "6");
  const b = await addProduct(page, "Builder Tight");
  await fillLine(page, b, "qty", "6");
  await expect(page.getByTestId("line-avail")).toHaveCount(2);
  for (const avail of await page.getByTestId("line-avail").all()) await expect(avail).toContainText("10 available · short by 2");
  await expect(page.getByTestId("short-count")).toHaveText("2 lines short of stock");
  await page.getByTestId("save-post").click();
  await expect(page.getByTestId("save-errors")).toContainText(`Only 10 bags of Builder Tight Pulses 20KG are available in ${second.name}. Requested: 12.`);
  await fillLine(page, b, "qty", "4");
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  expect(await stockOf(api, "tight", second.id)).toBe(0);
});

test("fractional bags and Urdu digits; more than 3 decimals is refused by line before anything is sent", async ({ open }) => {
  const { page } = await open("OWNER");
  const romeo = await findParty(api, "customers", SCENARIO.romeo.name);
  const { main } = await godowns(api);
  const stock0 = await stockOf(api, "priced", main.id);

  await page.goto("/invoices/new");
  await chooseShop(page, SCENARIO.romeo.name);
  const i = await addProduct(page, "Builder Priced");
  await fillLine(page, i, "qty", "2.5555");
  await page.getByTestId("save-post").click();
  await expect(page.getByTestId("save-errors")).toContainText("Line 1: Enter the number of bags — at most 3 decimal places");
  await expect(page.getByTestId("line-error").first()).toBeVisible();
  expect(await invoicesOf(romeo.id)).toHaveLength(0);

  await fillLine(page, i, "qty", "۲.۵"); // Urdu digits
  await expect(page.getByTestId("line-amount").first()).toHaveText("5,000.00");
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const inv = await invoiceDetailOf(api, page.url().split("/").pop()!);
  expect(inv.lines[0]!.quantity).toBe(2.5);
  expect(inv.totalP).toBe(500_000);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 2.5);
  expect(await balanceOf(api, "customers", romeo.id)).toBe(500_000);
  await expect(page.getByTestId("lines-table")).toContainText("2.5");
});

test("region → shop: the region narrows the shop list, and changing the region clears the shop", async ({ open }) => {
  const { page } = await open("OWNER");
  const regions = (await api.get<Region[]>("/regions")).filter((r) => r.active);
  const drosh = regions.find((r) => /Drosh/i.test(r.nameEn))!;
  const other = regions.find((r) => r.id !== drosh.id)!;
  await page.goto("/invoices/new");
  await page.getByTestId("region-select").selectOption({ value: drosh.id });
  const shop = page.getByRole("combobox", { name: "Shop" });
  await shop.click();
  const options = page.getByRole("listbox", { name: "shops" }).getByRole("option");
  await expect(options.first()).toBeVisible();
  for (const text of await options.allInnerTexts()) expect(text).toContain(drosh.nameEn);
  await shop.fill(SCENARIO.delta.name);
  await page.getByRole("listbox", { name: "shops" }).getByRole("option", { name: new RegExp(SCENARIO.delta.name) }).click();
  await expect(shop).toHaveValue(SCENARIO.delta.name);
  await expect(page.getByTestId("shop-card")).toContainText(drosh.nameEn);
  // changing the region clears the shop and the card
  await page.getByTestId("region-select").selectOption({ value: other.id });
  await expect(shop).toHaveValue("");
  await expect(page.getByTestId("shop-card")).toHaveCount(0);
});

test("product search: English and Urdu words, bag size, in-stock first for the warehouse, nothing found, the plain list; Tab / Enter go quantity → rate → discount", async ({ open }) => {
  const { page } = await open("OWNER");
  const { second } = await godowns(api);
  await page.goto("/invoices/new");
  const box = page.getByRole("searchbox", { name: "Search products" });
  const settled = () => expect(page.getByTestId("product-results")).toHaveAttribute("aria-busy", "false");

  await box.fill("priced rice");
  await settled();
  await expect(page.getByTestId("product-result")).toHaveCount(1);
  await expect(page.getByTestId("product-result").first()).toContainText("Builder Priced Rice 25KG");
  await box.fill("چاول"); // Urdu word from the Urdu name
  await settled();
  await expect(page.getByTestId("product-result").first()).toContainText("قیمت والا چاول");
  await box.fill("builder 25 kg"); // bag size: only the 25 kg product
  await settled();
  await expect(page.getByTestId("product-result")).toHaveCount(1);
  await expect(page.getByTestId("product-result").first()).toContainText("Builder Priced Rice 25KG");
  await box.fill("builder");
  await settled();
  await expect(page.getByTestId("product-result")).toHaveCount(5);
  await box.fill("zzznothing");
  await settled();
  await expect(page.getByTestId("no-products")).toContainText("Nothing matches “zzznothing”");

  // in stock HERE comes first: in the second godown the zero-stock product is last and says 0
  await page.getByTestId("header-warehouse").selectOption({ label: second.name });
  await box.fill("builder");
  await settled();
  const results = page.getByTestId("product-result");
  await expect(results.last()).toContainText("Builder ZeroStock Salt 5KG");
  await expect(results.last()).toContainText("Available: 0 Bags");
  await expect(results.first()).not.toContainText("Available: 0 Bags");

  // pick two products from the list, then the plain list
  await results.first().click();
  await page.keyboard.type("3");
  await page.keyboard.press("Enter"); // Enter goes to the next box instead of submitting
  await expect(page.getByTestId("line-rate").first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("line-discount").first()).toBeFocused();
  await page.getByTestId("plain-picker").locator("summary").click();
  const plain = page.getByLabel("Product (plain list)");
  await expect(plain.locator("option", { hasText: "Builder Tight" })).toHaveCount(1);
  await plain.selectOption(await plain.locator("option", { hasText: "Builder Tight" }).getAttribute("value"));
  await page.getByRole("button", { name: "Add this product" }).click();
  await expect(page.getByTestId("line-row")).toHaveCount(2);
});

test("edit a posted invoice UP and DOWN: the question first, the shop locked, stock and balance move by the difference (read back from the API); cancel still works afterwards", async ({ open }) => {
  const { page } = await open("OWNER");
  const sierra = await findParty(api, "customers", SCENARIO.sierra.name);
  const { main } = await godowns(api);
  const priced = await builderProduct(api, "priced", main.id);
  const stock0 = await stockOf(api, "priced", main.id);
  const inv = await saveViaApi(api, { customerId: sierra.id, warehouseId: main.id, lines: [{ productId: priced.id, quantity: 10, unitPriceP: 200_000 }] });
  expect(inv.totalP).toBe(2_000_000);

  await page.goto(`/invoices/${inv.id}`);
  await page.getByTestId("action-edit").click();
  // the question comes first
  const gate = page.getByRole("dialog", { name: "Edit a confirmed invoice?" });
  await expect(gate).toContainText("adjust stock and the shop’s balance by the difference");
  await gate.getByTestId("gate-continue").click();
  await expect(page.getByTestId("builder-title")).toHaveText(`Edit ${inv.number}`);
  // the shop is locked, with the hint; no Save-draft on a posted invoice
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveCount(0);
  await expect(page.getByTestId("shop-locked")).toHaveText(SCENARIO.sierra.name);
  await expect(page.getByTestId("shop-locked-hint")).toContainText("Change shop");
  await expect(page.getByTestId("save-draft")).toHaveCount(0);
  await expect(page.getByTestId("field-paidAmount")).toHaveValue("");

  // UP: 10 → 14 (its own 10 bags count as available again)
  await fillLine(page, 0, "qty", "14");
  await expect(page.getByTestId("line-avail").first()).toContainText(`${stock0 - 10 + 10} available`);
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${inv.id}$`));
  await expect(page.getByTestId("toast").filter({ hasText: "updated" }).first()).toBeVisible();
  let d = await invoiceDetailOf(api, inv.id);
  expect(d.number).toBe(inv.number);
  expect(d.totalP).toBe(2_800_000);
  expect(d.revision).toBeGreaterThan(inv.revision);
  expect(netBags(d)).toBe(-14);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 14);
  expect(await balanceOf(api, "customers", sierra.id)).toBe(2_800_000);

  // DOWN: 14 → 6
  await page.getByTestId("action-edit").click();
  await page.getByTestId("gate-continue").click();
  await fillLine(page, 0, "qty", "6");
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${inv.id}$`));
  await expect(page.getByTestId("grand-total")).toHaveText("12,000.00");
  d = await invoiceDetailOf(api, inv.id);
  expect(d.totalP).toBe(1_200_000);
  expect(netBags(d)).toBe(-6);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 6);
  expect(await balanceOf(api, "customers", sierra.id)).toBe(1_200_000);
  const st = await statementOf(api, "customers", sierra.id);
  expect(st.rows.filter((r) => r.kind === "INVOICE")).toHaveLength(1); // one invoice row, at the new amount
  expect(st.rows.find((r) => r.kind === "INVOICE")!.debitP).toBe(1_200_000);

  // the S9 cancel still works on an edited invoice: the bags come back, the balance is 0
  await page.getByTestId("action-cancel").click();
  const dlg = page.getByRole("dialog", { name: /Cancel INV-/ });
  await dlg.getByLabel("Reason").fill("customer changed his mind");
  await dlg.getByRole("button", { name: "Cancel invoice" }).click();
  await expect(page).toHaveURL(/\/invoices$/);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0);
  expect(await balanceOf(api, "customers", sierra.id)).toBe(0);
});

test("an invoice with a return or a dispatch cannot be edited: Edit is off with the server's reason, and the editor's address shows the same words instead of a form", async ({ open }) => {
  const { page } = await open("OWNER");
  const returned = (await allInvoices(api, "status=PARTIALLY_RETURNED"))[0]!;
  const dispatched = (await allInvoices(api, "status=DISPATCHED"))[0]!;
  expect(returned, "the dataset has a partly returned invoice").toBeTruthy();
  expect(dispatched, "the dataset has a dispatched invoice").toBeTruthy();
  for (const row of [returned, dispatched]) {
    const inv = await invoiceDetailOf(api, row.id);
    expect(inv.actions.edit.allowed).toBe(false);
    await page.goto(`/invoices/${inv.id}`);
    await expect(page.getByTestId("action-edit")).toBeDisabled();
    await expect(page.getByTestId("reason-edit")).toHaveText(inv.actions.edit.reason!);
    await page.goto(`/invoices/${inv.id}/edit`);
    await expect(page.getByTestId("edit-refused")).toContainText(inv.actions.edit.reason!);
    await expect(page.getByTestId("invoice-builder")).toHaveCount(0);
  }
  // a cancelled invoice: the legacy sentence
  const cancelled = (await allInvoices(api, "status=CANCELLED")).find((i) => i.number)!;
  await page.goto(`/invoices/${cancelled.id}/edit`);
  await expect(page.getByTestId("edit-refused")).toContainText("A cancelled invoice cannot be edited. Duplicate it instead.");
});

test("stale revision: saved elsewhere meanwhile → the server's words and Reload → the fresh copy replaces the form → the save then works", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the server refuses on purpose here; the browser logs every 422
  const { page } = await open("OWNER");
  const tango = await findParty(api, "customers", SCENARIO.tango.name);
  const { main } = await godowns(api);
  const priced = await builderProduct(api, "priced", main.id);
  const inv = await saveViaApi(api, { customerId: tango.id, warehouseId: main.id, lines: [{ productId: priced.id, quantity: 5, unitPriceP: 200_000 }] });

  await page.goto(`/invoices/${inv.id}/edit`);
  await page.getByTestId("gate-continue").click();
  await expect(page.getByTestId("line-qty").first()).toHaveValue("5");

  // someone else saves the same invoice (5 → 6) while this page is open
  const other = await api.put(`/invoices/${inv.id}`, {
    mode: "post", customerId: tango.id, warehouseId: main.id, revision: inv.revision, idempotencyKey: `e2e-other-${Date.now()}`,
    lines: [{ id: inv.lines[0]!.id, productId: priced.id, quantity: 6, unitPriceP: 200_000 }],
  });
  expect(other.status).toBe(200);

  await fillLine(page, 0, "qty", "7");
  await page.getByTestId("save-post").click();
  const stale = "This invoice was changed by someone else since you opened it. Reload it and make your change again.";
  await expect(page.getByTestId("save-errors")).toContainText(stale);
  expect((await invoiceDetailOf(api, inv.id)).lines[0]!.quantity).toBe(6); // this page's 7 was NOT applied

  await page.getByTestId("reload-invoice").click();
  await expect(page.getByTestId("line-qty").first()).toHaveValue("6"); // the other person's version
  await expect(page.getByTestId("save-errors")).toHaveCount(0);
  await fillLine(page, 0, "qty", "7");
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${inv.id}$`));
  expect((await invoiceDetailOf(api, inv.id)).lines[0]!.quantity).toBe(7);
  expect(await balanceOf(api, "customers", tango.id)).toBe(1_400_000);
});

test("SALES builds and posts, and has no Edit on a posted invoice (the server's reason); the ACCOUNTANT corrects it but has no New invoice; the warehouse role gets nothing", async ({ open }) => {
  const victor = await findParty(api, "customers", SCENARIO.victor.name);
  const { main } = await godowns(api);
  const stock0 = await stockOf(api, "priced", main.id);

  // SALES: New invoice → build → post
  const sales = (await open("SALES")).page;
  await sales.goto("/invoices");
  await expect(sales.getByTestId("new-invoice")).toBeVisible();
  await sales.getByTestId("new-invoice").click();
  await chooseShop(sales, SCENARIO.victor.name);
  const i = await addProduct(sales, "Builder Priced");
  await fillLine(sales, i, "qty", "5");
  await expect(sales.getByTestId("line-hint")).toHaveCount(0); // no cost figure for a role without PROFIT_VIEW
  await sales.getByTestId("save-post").click();
  await expect(sales).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const id = sales.url().split("/").pop()!;
  const inv = await invoiceDetailOf(api, id);
  expect(inv.status).toBe("CONFIRMED");
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 5);
  // … no Edit on the posted invoice: disabled with the server's own reason, and the editor's address refuses too
  expect(inv.actions.edit.allowed).toBe(true); // (the API call above was made as the OWNER)
  await expect(sales.getByTestId("action-edit")).toBeDisabled();
  await expect(sales.getByTestId("reason-edit")).toContainText("You do not have permission to edit a posted invoice");
  await sales.goto(`/invoices/${id}/edit`);
  await expect(sales.getByTestId("edit-refused")).toContainText("You do not have permission to edit a posted invoice");
  // a draft, on the other hand, SALES may edit and post
  const draft = await saveViaApi(api, { customerId: victor.id, warehouseId: main.id, mode: "draft", lines: [{ productId: (await builderProduct(api, "priced", main.id)).id, quantity: 1, unitPriceP: 200_000 }] });
  await sales.goto(`/invoices/${draft.id}`);
  await expect(sales.getByTestId("action-edit")).toBeEnabled();
  await expect(sales.getByTestId("action-post")).toBeEnabled();

  // ACCOUNTANT: Edit yes, New invoice no
  const acc = (await open("ACCOUNTANT")).page;
  await acc.goto("/invoices");
  await expect(acc.getByTestId("new-invoice")).toHaveCount(0);
  await acc.goto("/invoices/new");
  await expect(acc.getByTestId("not-available")).toContainText("Not available for the Accountant role");
  await acc.goto(`/invoices/${id}`);
  await expect(acc.getByTestId("action-edit")).toBeEnabled();
  await expect(acc.getByTestId("action-post")).toHaveCount(0);
  await acc.getByTestId("action-edit").click();
  await acc.getByTestId("gate-continue").click();
  await fillLine(acc, 0, "qty", "6");
  await acc.getByTestId("save-post").click();
  await expect(acc).toHaveURL(new RegExp(`/invoices/${id}$`));
  expect((await invoiceDetailOf(api, id)).totalP).toBe(1_200_000);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 6);
  // the accountant may not post a draft: Edit is disabled there, with the server's reason
  await acc.goto(`/invoices/${draft.id}`);
  await expect(acc.getByTestId("action-edit")).toBeDisabled();
  await expect(acc.getByTestId("reason-edit")).toContainText("You do not have permission to create or post invoices");

  // INVENTORY: nothing
  const inventory = (await open("INVENTORY")).page;
  await inventory.goto("/invoices/new");
  await expect(inventory.getByTestId("not-available")).toContainText("Not available for the Warehouse role");
  await inventory.goto(`/invoices/${id}/edit`);
  await expect(inventory.getByTestId("not-available")).toContainText("Not available for the Warehouse role");
  expect((await invoicesOf(victor.id)).length).toBe(2);
});

test("double-clicking Save makes ONE invoice; a network failure keeps the form and the retry (same key) still makes only one", async ({ open, allowConsoleErrors }) => {
  const uniform = await findParty(api, "customers", SCENARIO.uniform.name);
  const yankee = await findParty(api, "customers", SCENARIO.yankee.name);
  const { main } = await godowns(api);
  const stock0 = await stockOf(api, "priced", main.id);

  const { page } = await open("OWNER");
  await page.goto("/invoices/new");
  await chooseShop(page, SCENARIO.uniform.name);
  await fillLine(page, await addProduct(page, "Builder Priced"), "qty", "3");
  await page.getByTestId("save-post").dblclick();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await page.waitForTimeout(500);
  expect(await invoicesOf(uniform.id)).toHaveLength(1);
  expect(await balanceOf(api, "customers", uniform.id)).toBe(600_000);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 3);

  // the connection drops on the first attempt
  allowConsoleErrors.value = true; // a request the test aborts on purpose is logged by the browser
  await page.goto("/invoices/new");
  await chooseShop(page, SCENARIO.yankee.name);
  await fillLine(page, await addProduct(page, "Builder Priced"), "qty", "2");
  let attempts = 0;
  await page.route(/\/invoices$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    if (++attempts === 1) return route.abort("connectionreset");
    return route.continue();
  });
  await page.getByTestId("save-post").click();
  await expect(page.getByTestId("save-errors")).toContainText("Could not reach the server — nothing was saved");
  await expect(page.getByTestId("line-qty").first()).toHaveValue("2"); // the form is intact
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(SCENARIO.yankee.name);
  expect(await invoicesOf(yankee.id)).toHaveLength(0);
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  expect(await invoicesOf(yankee.id)).toHaveLength(1);
  expect(await balanceOf(api, "customers", yankee.id)).toBe(400_000);
});

test("live totals equal the server's to the paisa on a discounted, charged invoice; a taxed invoice opens at the server's total; Duplicate lands in the editor with the copied lines", async ({ open }) => {
  const { page } = await open("OWNER");
  const whiskey = await findParty(api, "customers", SCENARIO.whiskey.name);
  const { main } = await godowns(api);
  const priced = await builderProduct(api, "priced", main.id);
  const stock0 = await stockOf(api, "priced", main.id);

  await page.goto("/invoices/new");
  await chooseShop(page, SCENARIO.whiskey.name);
  const a = await addProduct(page, "Builder Priced");
  await fillLine(page, a, "qty", "3");
  await fillLine(page, a, "rate", "1,999.50");
  await fillLine(page, a, "discount", "250");
  const b = await addProduct(page, "Builder BelowCost");
  await fillLine(page, b, "qty", "7.5");
  await fillLine(page, b, "rate", "510");
  await page.getByTestId("field-invoiceDiscount").fill("100");
  await page.getByTestId("field-freight").fill("350.75");
  await page.getByTestId("field-loading").fill("120");
  await page.getByTestId("field-otherCharges").fill("80");
  // worked out by hand: 3 × 1,999.50 = 5,998.50; 7.5 × 510 = 3,825.00; subtotal 9,823.50; item discount 250; invoice discount 100; charges 350.75 + 120 + 80
  const expected = 599_850 + 382_500 - 25_000 - 10_000 + 35_075 + 12_000 + 8_000;
  expect(expected).toBe(1_002_425);
  expect(await screenGrandTotal(page)).toBe(expected);
  await expect(page.getByTestId("sticky-total")).toContainText("PKR 10,024.25");
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const inv = await invoiceDetailOf(api, page.url().split("/").pop()!);
  expect(inv.totalP).toBe(expected); // the server added it up the same way
  expect([inv.subtotalP, inv.itemDiscountsP, inv.invoiceDiscountP, inv.freightP, inv.loadingP, inv.otherChargesP]).toEqual([982_350, 25_000, 10_000, 35_075, 12_000, 8_000]);
  await expect(page.getByTestId("grand-total")).toHaveText("10,024.25");
  expect(await balanceOf(api, "customers", whiskey.id)).toBe(expected);

  // a TAXED invoice made through the API opens at the server's own total (the fixed tax is carried, not re-derived)
  const taxed = await saveViaApi(api, {
    customerId: whiskey.id, warehouseId: main.id,
    lines: [{ productId: priced.id, quantity: 4, unitPriceP: 200_000, discountP: 10_000, taxRatePct: 5 }, { productId: priced.id, quantity: 1.5, unitPriceP: 210_000 }],
    extra: { freightP: 5_000, invoiceDiscountP: 1_000 },
  });
  expect(taxed.taxP).toBe(39_500); // 5% of (800,000 − 10,000)
  await page.goto(`/invoices/${taxed.id}/edit`);
  await page.getByTestId("gate-continue").click();
  expect(await screenGrandTotal(page)).toBe(taxed.totalP);
  await expect(page.getByTestId("line-amount").first()).toContainText("incl. tax 395.00");

  // Duplicate → the editor, with the lines copied
  await page.goto(`/invoices/${taxed.id}`);
  await page.getByTestId("action-duplicate").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}\/edit$/);
  await expect(page.getByTestId("builder-title")).toHaveText("Edit draft");
  await expect(page.getByTestId("line-row")).toHaveCount(2);
  await expect(page.getByTestId("line-qty").nth(0)).toHaveValue("4");
  await expect(page.getByTestId("line-qty").nth(1)).toHaveValue("1.5");
  await expect(page.getByTestId("line-rate").nth(0)).toHaveValue("2000");
  await expect(page.getByTestId("line-discount").nth(0)).toHaveValue("100");
  expect(await screenGrandTotal(page)).toBe(taxed.totalP);
  const copyId = page.url().split("/").at(-2)!;
  const copy: InvoiceDetail = await invoiceDetailOf(api, copyId);
  expect(copy.status).toBe("DRAFT");
  expect(copy.number).toBeNull();
  expect(copy.totalP).toBe(taxed.totalP);
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 3 - 5.5); // only the two posted invoices took bags
});

test("leaving with unsaved changes asks first (in-app links and closing the tab); an untouched or restored form does not; discarding a saved draft does not ask afterwards", async ({ open }) => {
  const { page } = await open("OWNER");
  const xray = await findParty(api, "customers", SCENARIO.xray.name);
  const { main } = await godowns(api);
  const priced = await builderProduct(api, "priced", main.id);

  // untouched → no question
  await page.goto("/invoices/new");
  await page.getByRole("link", { name: "← All invoices" }).click();
  await expect(page).toHaveURL(/\/invoices$/);

  // typed and taken back → still no question
  await page.goto("/invoices/new");
  await page.getByTestId("field-notes").fill("x");
  await expect(page.getByTestId("dirty-note")).toBeVisible();
  await page.getByTestId("field-notes").fill("");
  await expect(page.getByTestId("dirty-note")).toHaveCount(0);
  await page.getByRole("link", { name: "← All invoices" }).click();
  await expect(page).toHaveURL(/\/invoices$/);

  // changed → the question; Keep editing stays with everything as it was, Leave goes
  await page.goto("/invoices/new");
  await page.getByTestId("field-notes").fill("deliver on Friday");
  await page.getByRole("link", { name: "← All invoices" }).click();
  const ask = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(ask).toBeVisible();
  await ask.getByTestId("stay").click();
  await expect(page).toHaveURL(/\/invoices\/new$/);
  await expect(page.getByTestId("field-notes")).toHaveValue("deliver on Friday");
  await page.getByRole("link", { name: "Invoices", exact: true }).first().click();
  await ask.getByTestId("leave").click();
  await expect(page).toHaveURL(/\/invoices$/);

  // closing / reloading the tab with changes is guarded by the browser
  await page.goto("/invoices/new");
  await page.getByTestId("field-notes").click();
  await page.keyboard.type("unsaved"); // real key presses: the browser only guards a page the person has interacted with
  const dialogSeen = page.waitForEvent("dialog");
  void page.evaluate(() => location.reload());
  const d = await dialogSeen;
  expect(d.type()).toBe("beforeunload");
  await d.dismiss();
  await expect(page.getByTestId("field-notes")).toHaveValue("unsaved");
  await page.getByTestId("field-notes").fill(""); // back to untouched, so the next address is not guarded

  // a saved draft, changed, then DISCARDED: the discard dialog needs a reason, and nothing asks about the unsaved change afterwards
  const draft = await saveViaApi(api, { customerId: xray.id, warehouseId: main.id, mode: "draft", lines: [{ productId: priced.id, quantity: 2, unitPriceP: 200_000 }] });
  await page.goto(`/invoices/${draft.id}/edit`);
  await page.getByTestId("field-notes").fill("about to be thrown away");
  await page.getByTestId("discard").click();
  const dlg = page.getByRole("dialog", { name: "Discard this draft?" });
  await dlg.getByLabel("Reason").fill("entered by mistake");
  await dlg.getByRole("button", { name: "Discard draft" }).click();
  await expect(page).toHaveURL(/\/invoices$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await invoiceDetailOf(api, draft.id)).status).toBe("CANCELLED");
});

test("Post invoice on a draft's page: it says what will happen, the stock refusal is shown verbatim, and after a fix the number is assigned, stock and balance move", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the server refuses on purpose here; the browser logs every 422
  const { page } = await open("OWNER");
  const xray = await findParty(api, "customers", SCENARIO.xray.name);
  const { main } = await godowns(api);
  const priced = await builderProduct(api, "priced", main.id);
  const stock0 = await stockOf(api, "priced", main.id);
  const before = await balanceOf(api, "customers", xray.id);

  const tooMany = await saveViaApi(api, { customerId: xray.id, warehouseId: main.id, mode: "draft", lines: [{ productId: priced.id, quantity: stock0 + 100, unitPriceP: 200_000 }] });
  await page.goto(`/invoices/${tooMany.id}`);
  await page.getByTestId("action-post").click();
  const dlg = page.getByRole("dialog", { name: "Post this invoice?" });
  await expect(dlg).toContainText("given its own invoice number");
  await expect(dlg).toContainText("The bags leave stock");
  await dlg.getByTestId("confirm-post").click();
  await expect(dlg).toContainText(`Only ${stock0} bags of Builder Priced Rice 25KG are available in ${main.name}. Requested: ${stock0 + 100}.`);
  await expect(dlg).toBeVisible(); // stays open
  expect((await invoiceDetailOf(api, tooMany.id)).status).toBe("DRAFT");
  await dlg.getByRole("button", { name: "Not yet" }).click();

  const ok = await saveViaApi(api, { customerId: xray.id, warehouseId: main.id, mode: "draft", lines: [{ productId: priced.id, quantity: 5, unitPriceP: 200_000 }] });
  await page.goto(`/invoices/${ok.id}`);
  await page.getByTestId("action-post").click();
  await page.getByRole("dialog", { name: "Post this invoice?" }).getByTestId("confirm-post").click();
  await expect(page.getByTestId("invoice-number")).toHaveText(/^INV-\d{4}-\d{6}$/);
  await expect(page.getByTestId("toast").filter({ hasText: "posted" }).first()).toBeVisible();
  const posted = await invoiceDetailOf(api, ok.id);
  expect(posted.status).toBe("CONFIRMED");
  expect(await stockOf(api, "priced", main.id)).toBe(stock0 - 5);
  expect(await balanceOf(api, "customers", xray.id)).toBe(before + 1_000_000);
  await expect(page.getByTestId("action-post")).toHaveCount(0); // a posted invoice has no Post
});

test("price hints only for a role that may see cost (below cost, below the minimum, low margin, ok); the start rate is the set price, else the last rate charged; no trace of cost for SALES", async ({ open }) => {
  const yankee = await findParty(api, "customers", SCENARIO.yankee.name);
  const { main } = await godowns(api);
  const lastRate = await builderProduct(api, "lastRate", main.id);
  // the last-rate product has no set price: a posted invoice at Rs 1,234 becomes its starting rate
  const seeded = await saveViaApi(api, { customerId: yankee.id, warehouseId: main.id, lines: [{ productId: lastRate.id, quantity: 1, unitPriceP: 123_400 }] });
  expect(seeded.status).toBe("CONFIRMED");

  const { page } = await open("OWNER");
  await page.goto("/invoices/new");
  const c = await addProduct(page, "Builder BelowCost");
  await expect(page.getByTestId("line-rate").nth(c)).toHaveValue("500"); // its set price, below its cost of 900
  await fillLine(page, c, "qty", "10");
  const hintOf = (n: number) => page.getByTestId("line-row").nth(n).getByTestId("line-hint");
  await expect(hintOf(c)).toHaveAttribute("data-kind", "below-cost");
  await expect(hintOf(c)).toHaveText("Below cost. Cost PKR 900/bag against PKR 500 — a loss of PKR 4,000 on this line.");
  const p = await addProduct(page, "Builder Priced"); // set price 2,000 · minimum 1,800 · cost 1,500
  await fillLine(page, p, "qty", "10");
  for (const [rate, kind] of [["1700", "below-min"], ["1400", "below-cost"], ["2000", "ok"]] as const) {
    await fillLine(page, p, "rate", rate);
    await expect(hintOf(p)).toHaveAttribute("data-kind", kind);
  }
  const l = await addProduct(page, "Builder LastRate"); // no set price, no minimum · cost 900
  await expect(page.getByTestId("line-rate").nth(l)).toHaveValue("1234");
  await fillLine(page, l, "qty", "10");
  await expect(hintOf(l)).toHaveAttribute("data-kind", "ok");
  await fillLine(page, l, "rate", "930"); // 3.2 % over cost
  await expect(hintOf(l)).toHaveAttribute("data-kind", "low-margin");
  await expect(hintOf(l)).toContainText("Low margin. Cost PKR 900/bag");

  // SALES: the same screen, no hint, no cost anywhere in what the browser received or drew
  const sales = (await open("SALES")).page;
  const seen: string[] = [];
  sales.on("response", async (r) => {
    if (/\/products/.test(r.url())) seen.push(await r.text().catch(() => ""));
  });
  await sales.goto("/invoices/new");
  const sc = await addProduct(sales, "Builder BelowCost");
  await fillLine(sales, sc, "qty", "10");
  await expect(sales.getByTestId("line-rate").nth(sc)).toHaveValue("500");
  await expect(sales.getByTestId("line-hint")).toHaveCount(0);
  const html = await sales.content();
  expect(html).not.toMatch(/Below cost|Low margin|Below the minimum|profit cannot be shown/);
  expect(seen.length).toBeGreaterThan(0);
  for (const body of seen) for (const row of JSON.parse(body) as { costP: number | null; buyP: number | null }[]) expect([row.costP, row.buyP]).toEqual([null, null]);
});

test("a product with no bags in the chosen godown: '0 available · short by 5' is a warning, a draft still saves, posting is refused by the server", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the server refuses on purpose here; the browser logs every 422
  const { page } = await open("OWNER");
  const yankee = await findParty(api, "customers", SCENARIO.yankee.name);
  const { second } = await godowns(api);
  await page.goto("/invoices/new");
  await chooseShop(page, SCENARIO.yankee.name);
  await page.getByTestId("header-warehouse").selectOption({ label: second.name });
  const i = await addProduct(page, "Builder ZeroStock");
  await fillLine(page, i, "qty", "5");
  await expect(page.getByTestId("line-avail").first()).toHaveText("0 available · short by 5");
  await page.getByTestId("save-post").click();
  await expect(page.getByTestId("save-errors")).toContainText(`Only 0 bags of Builder ZeroStock Salt 5KG are available in ${second.name}. Requested: 5.`);
  const before = (await invoicesOf(yankee.id)).length;
  await page.getByTestId("save-draft").click(); // a draft has no stock effect: the server saves it
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const draft = await invoiceDetailOf(api, page.url().split("/").pop()!);
  expect(draft.status).toBe("DRAFT");
  expect((await invoicesOf(yankee.id)).length).toBe(before + 1);
  expect(draft.stockMovements).toHaveLength(0);
});

test("on a phone (390 px): lines are cards, one representation only, the total and Save stay in reach, no sideways scrolling; a whole invoice can be built and posted", async ({ open }) => {
  const { page } = await open("OWNER", { width: 390, height: 780 });
  const zulu = await findParty(api, "customers", SCENARIO.zulu.name);
  await page.goto("/invoices/new");
  await expect(page.getByTestId("lines-editor")).toHaveCount(0);
  await chooseShop(page, SCENARIO.zulu.name);
  for (const name of ["Builder Priced", "Builder BelowCost", "Builder Tight", "Builder LastRate"]) {
    const i = await addProduct(page, name);
    await fillLine(page, i, "qty", "1");
  }
  await expect(page.getByTestId("lines-cards")).toBeVisible();
  await expect(page.getByTestId("lines-editor")).toHaveCount(0);
  await expect(page.getByTestId("line-row")).toHaveCount(4);
  // even with four cards on screen, the total and the buttons are in view without scrolling to them
  await expect(page.getByTestId("sticky-bar")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("save-post")).toBeInViewport({ ratio: 1 });
  const docWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(docWidth.scroll).toBeLessThanOrEqual(docWidth.client);
  const grand = await screenGrandTotal(page);
  await page.getByTestId("save-post").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const inv = await invoiceDetailOf(api, page.url().split("/").pop()!);
  expect(inv.totalP).toBe(grand);
  expect(inv.lines).toHaveLength(4);
  expect(await balanceOf(api, "customers", zulu.id)).toBe(grand);
});
