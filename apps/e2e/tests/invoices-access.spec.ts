import { readFileSync } from "node:fs";
import { ROLES, type Role } from "@farooq/shared";
import { readState } from "../setup/env";
import { test, expect, apiAs, invoicesList } from "./fixtures";

/** Who sees Invoices: the nav per role, the warehouse role's direct-URL panel, and the API's own 403 (the screen is not the only gate). */

const nav = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Main", exact: true });

for (const role of ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"] as Role[]) {
  test(`${role}: Invoices is in the nav, opens the list, and the list has rows and cards`, async ({ open }) => {
    const { page } = await open(role);
    await page.goto("/");
    await nav(page).getByRole("link", { name: "Invoices" }).click();
    await expect(page).toHaveURL(/\/invoices$/);
    await expect(page.getByRole("heading", { name: "Invoices", level: 1 })).toBeVisible();
    await expect(page.getByTestId("invoice-row").first()).toBeVisible();
    await expect(page.getByTestId("kpis")).toBeVisible();
    // there is no "New invoice" / "Edit" yet — the builder is S10
    await expect(page.getByRole("button", { name: /new invoice/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /new invoice/i })).toHaveCount(0);
  });
}

test("INVENTORY (warehouse): no Invoices in the nav; every invoice URL gets the not-available panel and no data", async ({ open }) => {
  const { page } = await open("INVENTORY");
  const owner = await apiAs("OWNER");
  const someId = (await invoicesList(owner, "limit=1")).items[0]!.id;
  await page.goto("/");
  await expect(nav(page).getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Invoices" })).toHaveCount(0);
  for (const url of ["/invoices", `/invoices/${someId}`, `/invoices/${someId}/print`]) {
    await page.goto(url);
    const panel = page.getByTestId("not-available");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Not available for the Warehouse role");
    await expect(page.getByTestId("invoice-row")).toHaveCount(0);
    await expect(page.getByTestId("invoice-paper")).toHaveCount(0);
  }
});

test("the API says the same: readers get the list, the warehouse role gets 403 on list, detail, print and CSV", async () => {
  const owner = await apiAs("OWNER");
  const id = (await invoicesList(owner, "limit=1")).items[0]!.id;
  const state = readState();
  for (const role of ROLES) {
    const cookie = `fc_sid=${JSON.parse(readFileSync(state.users[role].storageState, "utf8")).cookies[0].value as string}`;
    for (const path of ["/invoices?limit=1", `/invoices/${id}`, `/invoices/${id}/print`, "/invoices/export.csv"]) {
      const res = await fetch(`${state.apiUrl}${path}`, { headers: { cookie } });
      expect(res.status, `${role} ${path}`).toBe(role === "INVENTORY" ? 403 : 200);
    }
  }
});
