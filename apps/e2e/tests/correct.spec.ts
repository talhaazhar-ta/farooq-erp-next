import type { Page } from "@playwright/test";
import { test, expect, apiAs, balanceOf, findParty, paymentDetail, paymentsList, allPayments, SCENARIO, type Api } from "./fixtures";

/** Reverse and Edit amount: what the dialogs promise, what the server did, and the refusals shown with the server's own reason. */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

const dialog = (page: Page, name: RegExp | string) => page.getByRole("dialog", { name });

test("Reverse: says what will happen, needs a reason, restores the balance, and cannot be done twice", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the second reverse below is refused on purpose
  const { page } = await open("OWNER");
  const shop = await findParty(api, "customers", SCENARIO.foxtrot.name);
  const voucher = await api.postOk("/payments/receive", { customerId: shop.id, amountP: 500_000, note: "e2e reverse" });
  expect(await balanceOf(api, "customers", shop.id)).toBe(-500_000);
  const reversedBefore = (await paymentsList(api, "limit=1")).facets.reversed.count;

  await page.goto(`/payments/${voucher.id}`);
  await expect(page.getByTestId("voucher-number")).toHaveText(voucher.receiptNumber);
  await page.getByRole("button", { name: "Reverse voucher" }).click();

  const dlg = dialog(page, /Reverse REC-/);
  await expect(dlg).toBeVisible();
  // it says, before anything happens, what it will do to the party's account
  await expect(dlg).toContainText("The shop’s balance goes up by PKR 5,000.00");
  await expect(dlg).toContainText("cannot be reversed again");
  const confirm = dlg.getByRole("button", { name: "Reverse voucher" });
  await expect(confirm).toBeDisabled(); // a reason is required
  await confirm.click({ force: true });
  expect(await balanceOf(api, "customers", shop.id)).toBe(-500_000); // a click without a reason did nothing
  await dlg.getByLabel("Reason").fill("entered against the wrong shop");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByTestId("reversed-banner")).toContainText("entered against the wrong shop");
  await expect(page.getByTestId("voucher-number")).toHaveClass(/line-through/);
  // a second reverse is impossible in the UI, and the reason is on screen
  await expect(page.getByRole("button", { name: "Reverse voucher" })).toBeDisabled();
  const after = await paymentDetail(api, voucher.id);
  expect(after.status).toBe("REVERSED");
  await expect(page.getByTestId("reverse-reason")).toHaveText(after.actions.reverse.reason!);
  await expect(page.getByTestId("edit-reason")).toHaveText(after.actions.editAmount.reason!);
  expect(after.actions.reverse.reason).toBeTruthy();
  // …and impossible at the API too
  const again = await api.post(`/payments/${voucher.id}/reverse`, { reason: "again" });
  expect(again.status).toBe(422);

  // the money is back where it was, the statement no longer shows the voucher, the Reversed tab counts it
  expect(await balanceOf(api, "customers", shop.id)).toBe(0);
  await page.goto(`/statements?type=customer&partyId=${shop.id}`);
  await expect(page.getByTestId("statement-closing")).toContainText("Settled");
  await expect(page.getByTestId("statement-table")).not.toContainText(voucher.receiptNumber);
  await expect(page.getByTestId("statement-omitted")).toHaveText("1 reversed voucher is not shown.");
  await page.goto("/payments");
  await expect(page.getByTestId("tab-count-reversed")).toHaveText(String(reversedBefore + 1));
});

test("Edit amount: works on a voucher paid out to a shop, shows the effect, and the balance and statement follow", async ({ open }) => {
  const { page } = await open("OWNER");
  const shop = await findParty(api, "customers", SCENARIO.golf.name);
  const voucher = await api.postOk("/payments/refund", { customerId: shop.id, amountP: 100_000 });
  expect(await balanceOf(api, "customers", shop.id)).toBe(100_000);

  await page.goto(`/payments/${voucher.id}`);
  await expect(page.getByTestId("voucher-amount")).toHaveText("PKR 1,000.00");
  await page.getByRole("button", { name: "Edit amount" }).click();
  const dlg = dialog(page, /Correct the amount of /);
  await expect(dlg).toContainText("Current amount: PKR 1,000.00");
  const save = dlg.getByRole("button", { name: "Save new amount" });
  await expect(save).toBeDisabled(); // unchanged
  await dlg.getByLabel("Correct amount").fill("12.345");
  await expect(dlg).toContainText("at most 2 decimal");
  await expect(save).toBeDisabled();
  await dlg.getByLabel("Correct amount").fill("0");
  await expect(save).toBeDisabled();
  await dlg.getByLabel("Correct amount").fill("1,500");
  await expect(dlg.getByTestId("edit-effect")).toContainText("rise by PKR 500.00");
  await dlg.getByLabel("Reason").fill("wrong amount typed");
  await save.click();

  await expect(page.getByTestId("voucher-amount")).toHaveText("PKR 1,500.00");
  expect((await paymentDetail(api, voucher.id)).amountP).toBe(150_000);
  expect(await balanceOf(api, "customers", shop.id)).toBe(150_000);
  await page.goto(`/statements?type=customer&partyId=${shop.id}`);
  await expect(page.getByTestId("statement-closing")).toContainText("Shop owes us PKR 1,500.00");
});

test("refusals are shown disabled with the server's own reason: reversed, money received, and a supplier payment applied to a purchase", async ({ open }) => {
  const { page } = await open("OWNER");
  const reversed = (await allPayments(api, "status=REVERSED"))[0]!;
  const received = (await allPayments(api, "status=POSTED&direction=received"))[0]!;
  const allocated = (await allPayments(api, "status=POSTED&direction=paidToSuppliers")).find((p) => p.allocatedP > 0)!;

  for (const p of [reversed, received, allocated]) {
    const detail = await paymentDetail(api, p.id);
    await page.goto(`/payments/${p.id}`);
    await expect(page.getByTestId("voucher-number")).toHaveText(p.receiptNumber);
    const edit = page.getByRole("button", { name: "Edit amount" });
    await expect(edit).toBeDisabled();
    expect(detail.actions.editAmount.allowed).toBe(false);
    await expect(page.getByTestId("edit-reason")).toHaveText(detail.actions.editAmount.reason!);
  }
  const allocatedDetail = await paymentDetail(api, allocated.id);
  expect(allocatedDetail.actions.editAmount.reason).toMatch(/applied to an invoice or purchase/);
  await expect(page.getByTestId("edit-reason")).toContainText("applied to an invoice or purchase");
  expect((await paymentDetail(api, received.id)).actions.editAmount.reason).toMatch(/Only a voucher paid to a shop or a supplier/);
  // an allocated voucher CAN still be reversed (which releases the invoices) — the button is live
  await expect(page.getByRole("button", { name: "Reverse voucher" })).toBeEnabled();
  await expect(page.getByRole("region", { name: "Applied to" })).toBeVisible();
});

test("SALES sees the voucher but no Corrections, and the API refuses them too", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true;
  const { page } = await open("SALES");
  const any = (await paymentsList(api, "status=POSTED&limit=1")).items[0]!;
  await page.goto(`/payments/${any.id}`);
  await expect(page.getByTestId("voucher-number")).toHaveText(any.receiptNumber);
  await expect(page.getByRole("region", { name: "Corrections" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Reverse voucher|Edit amount/ })).toHaveCount(0);
  const sales = await apiAs("SALES");
  expect((await sales.post(`/payments/${any.id}/reverse`, { reason: "nope" })).status).toBe(403);
  expect((await sales.post(`/payments/${any.id}/edit-amount`, { amountP: 100 })).status).toBe(403);
  expect((await sales.post("/payments/pay", { supplierId: any.partyId, amountP: 100 })).status).toBe(403);
  expect((await paymentDetail(api, any.id)).status).toBe("POSTED");
});

test("an unknown voucher is a plain 'not found', not a blank page", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true;
  const { page } = await open("OWNER");
  await page.goto("/payments/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Payment not found")).toBeVisible();
  await page.goto("/payments/not-an-id/receipt");
  await expect(page.getByText("Payment not found")).toBeVisible();
});
