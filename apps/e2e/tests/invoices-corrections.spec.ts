import type { Page } from "@playwright/test";
import type { ProductPickItem, Statement } from "@farooq/shared";
import { test, expect, apiAs, balanceOf, findParty, invoiceDetailOf, postInvoice, stockBasics, paisaOf, SCENARIO, type Api } from "./fixtures";

/**
 * Cancel, discard, duplicate and change shop, through the screens, against the real server. Each test that moves money owns
 * a shop of its own (Kilo, Lima, Mike + November, Oscar). Expected figures come from the API, and what the server did is
 * checked after every screen action.
 */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

const dialog = (page: Page, name: RegExp | string) => page.getByRole("dialog", { name });

async function available(productId: string, warehouseId: string): Promise<number> {
  const rows = await api.get<ProductPickItem[]>(`/products?warehouseId=${warehouseId}&limit=100`);
  return rows.find((p) => p.id === productId)!.available.find((a) => a.warehouseId === warehouseId)?.quantity ?? 0;
}

test("cancel is refused while a receipt stands (and lists it) → reverse the receipt in the UI → cancel works → the statement omits it and the bags are back", async ({ open }) => {
  const { page } = await open("OWNER");
  const kilo = await findParty(api, "customers", SCENARIO.kilo.name);
  const { warehouse, product } = await stockBasics(api);
  const before = await available(product.id, warehouse.id);
  const inv = await postInvoice(api, { customerId: kilo.id, paidAmountP: 1_000_000 }); // 20 bags × 1,500 = 30,000, of which 10,000 paid at the sale
  expect(inv.totalP).toBe(3_000_000);
  expect(await available(product.id, warehouse.id)).toBe(before - 20);
  expect(await balanceOf(api, "customers", kilo.id)).toBe(2_000_000);
  const receipt = inv.receipts.find((r) => r.status === "POSTED")!;

  // 1. refused, with the server's reason, and the receipt listed with a link
  await page.goto(`/invoices/${inv.id}`);
  await expect(page.getByTestId("action-cancel")).toBeDisabled();
  await expect(page.getByTestId("reason-cancel")).toHaveText(inv.actions.cancel.reason!);
  await expect(page.getByTestId("reason-cancel")).toContainText(receipt.receiptNumber);
  await expect(page.getByTestId("receipt-links").getByRole("link", { name: receipt.receiptNumber })).toBeVisible();

  // 2. reverse that receipt on its voucher page
  await page.getByTestId("receipt-links").getByRole("link", { name: receipt.receiptNumber }).click();
  await expect(page.getByTestId("voucher-number")).toHaveText(receipt.receiptNumber);
  await page.getByRole("button", { name: "Reverse voucher" }).click();
  const rev = dialog(page, /Reverse REC-/);
  await rev.getByLabel("Reason").fill("taken by mistake");
  await rev.getByRole("button", { name: "Reverse voucher" }).click();
  await expect(page.getByTestId("reversed-banner")).toBeVisible();
  expect(await balanceOf(api, "customers", kilo.id)).toBe(3_000_000); // the shop owes the whole invoice again

  // 3. the invoice now allows the cancel; the dialog says what will happen and needs a reason
  await page.goto(`/invoices/${inv.id}`);
  await expect(page.getByTestId("action-cancel")).toBeEnabled();
  await page.getByTestId("action-cancel").click();
  const dlg = dialog(page, /Cancel INV-/);
  await expect(dlg).toContainText("The bags come back into stock");
  await expect(dlg).toContainText("PKR 30,000.00");
  const confirm = dlg.getByRole("button", { name: "Cancel invoice" });
  await expect(confirm).toBeDisabled();
  await dlg.getByLabel("Reason").fill("customer changed his mind");
  await confirm.click();
  await expect(page).toHaveURL(/\/invoices$/);
  await expect(page.getByTestId("toast").first()).toContainText(`${inv.number} cancelled. Stock has been returned and the balance reversed.`);

  // 4. what the server did
  const after = await invoiceDetailOf(api, inv.id);
  expect(after.status).toBe("CANCELLED");
  expect(after.cancelReason).toBe("customer changed his mind");
  expect(await available(product.id, warehouse.id)).toBe(before); // the bags came back
  expect(await balanceOf(api, "customers", kilo.id)).toBe(0);
  const st = await api.get<Statement>(`/customers/${kilo.id}/statement`);
  expect(st.rows.map((r) => r.ref)).not.toContain(inv.number);
  await page.goto(`/statements?type=customer&partyId=${kilo.id}`);
  await expect(page.getByTestId("statement-closing")).toContainText("Settled");
  await expect(page.getByTestId("statement-table")).not.toContainText(inv.number!);

  // the view page shows the stock coming back (bags on the detail): the sale and its reversal
  await page.goto(`/invoices/${inv.id}`);
  await expect(page.getByTestId("cancelled-banner")).toContainText("customer changed his mind");
  const qtys = (await page.getByTestId("stock-qty").allInnerTexts()).map((q) => Number(q.replace("+", "")));
  expect(qtys).toEqual([-20, 20]);
  await expect(page.getByTestId("action-cancel")).toBeDisabled();
  await expect(page.getByTestId("reason-cancel")).toHaveText("This invoice is already cancelled.");
  // and the list counts it as cancelled
  await page.goto(`/invoices?q=${encodeURIComponent(inv.number!)}`);
  await expect(page.getByTestId("invoice-row")).toHaveAttribute("data-status", "CANCELLED");
});

test("SALES discards a DRAFT (reason required), but is not offered — and the API refuses — cancelling a posted invoice", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the API refusal below is a 403 on purpose
  const sales = await apiAs("SALES");
  const lima = await findParty(api, "customers", SCENARIO.lima.name);
  const draft = await postInvoice(sales, { customerId: lima.id, mode: "draft" });
  expect(draft.status).toBe("DRAFT");
  expect(draft.number).toBeNull();

  const { page } = await open("SALES");
  await page.goto(`/invoices/${draft.id}`);
  await expect(page.getByTestId("invoice-number")).toHaveText("Draft");
  await expect(page.getByTestId("action-cancel")).toHaveText("Discard draft");
  await expect(page.getByTestId("action-cancel")).toBeEnabled();
  await expect(page.getByTestId("action-change-shop")).toHaveCount(0);
  await page.getByTestId("action-cancel").click();
  const dlg = dialog(page, "Discard this draft?");
  await expect(dlg).toContainText("no number, no stock and no account entry");
  await expect(dlg.getByRole("button", { name: "Discard draft" })).toBeDisabled();
  await dlg.getByLabel("Reason").fill("entered twice");
  await dlg.getByRole("button", { name: "Discard draft" }).click();
  await expect(page).toHaveURL(/\/invoices$/);
  await expect(page.getByTestId("toast").first()).toContainText("Draft discarded");
  expect((await invoiceDetailOf(api, draft.id)).status).toBe("CANCELLED");

  // a posted invoice: no Cancel button, no Change shop for SALES — and the server would say no anyway
  const posted = await postInvoice(api, { customerId: lima.id });
  await page.goto(`/invoices/${posted.id}`);
  await expect(page.getByTestId("invoice-number")).toHaveText(posted.number!);
  await expect(page.getByTestId("action-cancel")).toHaveCount(0);
  await expect(page.getByTestId("action-change-shop")).toHaveCount(0);
  await expect(page.getByTestId("action-duplicate")).toBeEnabled();
  const refused = await sales.post(`/invoices/${posted.id}/cancel`, { reason: "trying" });
  expect(refused.status).toBe(403);
  expect((await invoiceDetailOf(api, posted.id)).status).not.toBe("CANCELLED");
});

test("Duplicate makes a new DRAFT of the same lines and opens it (no number, no stock, no money)", async ({ open }) => {
  const { page } = await open("OWNER");
  const lima = await findParty(api, "customers", SCENARIO.lima.name);
  const original = await postInvoice(api, { customerId: lima.id, second: true });
  const balanceBefore = await balanceOf(api, "customers", lima.id);
  await page.goto(`/invoices/${original.id}`);
  await page.getByTestId("action-duplicate").click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(page).not.toHaveURL(new RegExp(original.id));
  await expect(page.getByTestId("invoice-number")).toHaveText("Draft");
  await expect(page.getByTestId("draft-banner")).toBeVisible();
  await expect(page.getByTestId("toast").first()).toContainText(`New draft created from ${original.number}`);
  const copyId = page.url().split("/").pop()!;
  const copy = await invoiceDetailOf(api, copyId);
  expect(copy.status).toBe("DRAFT");
  expect(copy.number).toBeNull();
  expect(copy.lines.map((l) => [l.productId, l.quantity, l.unitPriceP])).toEqual(original.lines.map((l) => [l.productId, l.quantity, l.unitPriceP]));
  expect(copy.stockMovements).toHaveLength(0);
  expect(await balanceOf(api, "customers", lima.id)).toBe(balanceBefore); // a draft touches no account
  await expect(page.getByTestId("line-row")).toHaveCount(original.lines.length);
  // a draft offers Discard, Duplicate and Print — and says nothing about editing
  await expect(page.getByRole("link", { name: "Print" })).toBeVisible();
  await expect(page.getByTestId("action-cancel")).toHaveText("Discard draft");
  await expect(page.getByText(/\bedit\b/i)).toHaveCount(0);
});

test("Change shop: starts blank, shows both shops' balances before → after (= the API's), refuses the same shop, moves the invoice and the receipt taken with it", async ({ open }) => {
  const { page } = await open("OWNER");
  const mike = await findParty(api, "customers", SCENARIO.mike.name);
  const november = await findParty(api, "customers", SCENARIO.november.name);
  const inv = await postInvoice(api, { customerId: mike.id, paidAmountP: 1_000_000 }); // 30,000 with 10,000 taken at the sale
  const receipt = inv.receipts.find((r) => r.status === "POSTED")!;
  const mikeNow = await balanceOf(api, "customers", mike.id);
  const novNow = await balanceOf(api, "customers", november.id);
  expect(mikeNow).toBe(2_000_000);
  const net = inv.totalP - receipt.allocatedP; // what really changes hands

  await page.goto(`/invoices/${inv.id}`);
  await page.getByTestId("action-change-shop").click();
  const dlg = dialog(page, "Change shop");
  const combo = dlg.getByRole("combobox", { name: "Correct shop" });
  await expect(combo).toHaveValue(""); // never pre-selected
  await expect(dlg.getByRole("button", { name: "Move invoice" })).toBeDisabled();
  await expect(dlg.getByTestId("cs-moving")).toContainText(receipt.receiptNumber);
  await expect(dlg.getByTestId("cs-old-now")).toContainText(money(mikeNow));
  await expect(dlg.getByTestId("cs-old-after")).toContainText(money(mikeNow - net));

  // the shop the invoice is already on is refused
  await combo.click();
  await combo.fill(SCENARIO.mike.name);
  await dlg.getByRole("option", { name: new RegExp(SCENARIO.mike.name) }).click();
  await expect(dlg.getByText("That is already the shop on this invoice.")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Move invoice" })).toBeDisabled();

  await combo.click();
  await combo.fill(SCENARIO.november.name);
  await dlg.getByRole("option", { name: new RegExp(SCENARIO.november.name) }).click();
  await expect(dlg.getByTestId("cs-new-now")).toContainText(money(novNow));
  await expect(dlg.getByTestId("cs-new-after")).toContainText(money(novNow + net));
  await dlg.getByLabel("Reason (optional)").fill("picked the wrong shop");
  await dlg.getByRole("button", { name: "Move invoice" }).click();
  await expect(page.getByTestId("toast").first()).toContainText(`${inv.number} now belongs to ${SCENARIO.november.name}.`);
  await expect(page.getByTestId("invoice-shop")).toHaveText(SCENARIO.november.name);

  // what the server did: the invoice and the receipt moved, the balances are the ones the panel promised
  const moved = await invoiceDetailOf(api, inv.id);
  expect(moved.customerId).toBe(november.id);
  expect(await balanceOf(api, "customers", mike.id)).toBe(mikeNow - net);
  expect(await balanceOf(api, "customers", november.id)).toBe(novNow + net);
  expect(moved.receipts.map((r) => r.receiptNumber)).toEqual([receipt.receiptNumber]);
  const mikeRefs = (await api.get<Statement>(`/customers/${mike.id}/statement`)).rows.map((r) => r.ref);
  expect(mikeRefs).not.toContain(inv.number);
  expect(mikeRefs).not.toContain(receipt.receiptNumber);
  const novRefs = (await api.get<Statement>(`/customers/${november.id}/statement`)).rows.map((r) => r.ref);
  expect(novRefs).toEqual(expect.arrayContaining([inv.number!, receipt.receiptNumber]));
});

test("Change shop: a receipt that also paid another invoice cannot move — the server's refusal is shown verbatim and nothing changes", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the 422 the panel shows is logged by the browser
  const { page } = await open("OWNER");
  const oscar = await findParty(api, "customers", SCENARIO.oscar.name);
  const november = await findParty(api, "customers", SCENARIO.november.name);
  const a = await postInvoice(api, { customerId: oscar.id });
  const b = await postInvoice(api, { customerId: oscar.id, qty: 10 });
  // the page is opened FIRST, while the move is still allowed …
  await page.goto(`/invoices/${a.id}`);
  await expect(page.getByTestId("action-change-shop")).toBeEnabled();
  // … then one receipt of 30,000 + 15,000 covers all of A and half of B, so it belongs to the shop, not to one invoice
  await api.postOk("/payments/receive", { customerId: oscar.id, amountP: 4_500_000, allocations: [{ invoiceId: a.id, amountP: 3_000_000 }, { invoiceId: b.id, amountP: 1_500_000 }] });
  const balanceBefore = await balanceOf(api, "customers", oscar.id);

  // the screen still offers the move (its data is a moment old); the server says no, and the panel shows exactly what it said
  await page.getByTestId("action-change-shop").click();
  const dlg = dialog(page, "Change shop");
  const combo = dlg.getByRole("combobox", { name: "Correct shop" });
  await combo.click();
  await combo.fill(SCENARIO.november.name);
  await dlg.getByRole("option", { name: new RegExp(SCENARIO.november.name) }).click();
  await dlg.getByRole("button", { name: "Move invoice" }).click();
  await expect(dlg.getByTestId("error-lines")).toContainText("was also applied to other invoices or left partly on account, so it belongs to the shop, not to this one invoice.");
  await expect(dlg).toBeVisible(); // nothing closed
  await dlg.getByRole("button", { name: "Cancel" }).click();

  // after a reload the button is off, with the server's own words
  await page.reload();
  const fresh = await invoiceDetailOf(api, a.id);
  expect(fresh.actions.changeShop.allowed).toBe(false);
  await expect(page.getByTestId("action-change-shop")).toBeDisabled();
  await expect(page.getByTestId("reason-change-shop")).toHaveText(fresh.actions.changeShop.reason!);
  expect((await invoiceDetailOf(api, a.id)).customerId).toBe(oscar.id);
  expect(await balanceOf(api, "customers", oscar.id)).toBe(balanceBefore);
  expect(november.id).not.toBe(oscar.id);
});

const money = (p: number): string => `${paisaText(p)}`;
function paisaText(p: number): string {
  return (p / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
void paisaOf;
