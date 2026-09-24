import { test as base, expect } from "@playwright/test";
import { ROLE_LABELS, type Role } from "@farooq/shared";
import { readState } from "../setup/env";

// These specs sign in through the real form (5 roles + 1 wrong password = 6 of the 20 attempts the throttle allows per 15 min).
const test = base;

async function signIn(page: import("@playwright/test").Page, role: Role) {
  const u = readState().users[role];
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/); // no session → the sign-in page
  await page.locator("#username").fill(u.username);
  await page.locator("#password").fill(u.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("user-role")).toContainText(ROLE_LABELS[role]);
}

const nav = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Main", exact: true });

for (const role of ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"] as Role[]) {
  test(`${role}: signs in and sees Payments and Statements in the nav`, async ({ page }) => {
    await signIn(page, role);
    await expect(nav(page).getByRole("link", { name: "Payments" })).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Statements" })).toBeVisible();
    // modules that do not exist yet are visibly disabled, not dead links
    for (const soon of ["Customers", "Suppliers", "Reports"]) {
      const entry = nav(page).getByText(soon, { exact: false }).first();
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAttribute("aria-disabled", "true");
      await expect(entry).toContainText("Soon");
    }
    await nav(page).getByRole("link", { name: "Payments" }).click();
    await expect(page).toHaveURL(/\/payments$/);
    await expect(page.getByRole("heading", { name: "Payments", level: 1 })).toBeVisible();
    // Receive is for everyone who may take money; pay-outs are not for SALES
    await expect(page.getByRole("button", { name: "Receive payment" })).toBeVisible();
    const payouts = page.getByRole("button", { name: /^(Pay supplier|Pay a shop)$/ });
    if (role === "SALES") await expect(payouts).toHaveCount(0);
    else await expect(payouts).toHaveCount(2);
  });
}

test("INVENTORY (warehouse): no Payments / Statements in the nav, and a direct URL gets the not-available panel", async ({ page }) => {
  await signIn(page, "INVENTORY");
  await expect(nav(page).getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Payments" })).toHaveCount(0);
  await expect(nav(page).getByRole("link", { name: "Statements" })).toHaveCount(0);
  for (const url of ["/payments", "/statements", "/payments/00000000-0000-4000-8000-000000000000", "/payments/00000000-0000-4000-8000-000000000000/receipt"]) {
    await page.goto(url);
    const panel = page.getByTestId("not-available");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Not available for the Warehouse role");
    await expect(page.getByTestId("payment-row")).toHaveCount(0);
  }
});

test("a wrong password says so and does not sign in; signing out returns to the sign-in page", async ({ page }) => {
  const u = readState().users.OWNER;
  await page.goto("/sign-in");
  await page.locator("#username").fill(u.username);
  await page.locator("#password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.locator("#password").fill(u.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("user-role")).toContainText("Owner");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/payments");
  await expect(page).toHaveURL(/\/sign-in$/); // the session is really gone
});

test("a session that ends mid-use sends the person back to sign-in (401), not to a broken screen", async ({ browser }) => {
  const s = readState();
  const context = await browser.newContext({ storageState: s.users.OWNER.storageState });
  const page = await context.newPage();
  await page.goto("/payments");
  await expect(page.getByTestId("payment-row").first()).toBeVisible();
  await context.clearCookies(); // the server no longer knows this browser
  await page.getByTestId("tab-received").click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await context.close();
});
