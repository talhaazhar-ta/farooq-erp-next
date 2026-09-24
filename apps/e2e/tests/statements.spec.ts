import { readFileSync } from "node:fs";
import type { Statement } from "@farooq/shared";
import { test, expect, apiAs, balanceOf, findParty, paisaOf, parseCsv, SCENARIO, type Api } from "./fixtures";

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

interface Lookup {
  id: string;
  name: string;
}
const money = (paisa: number) => (Math.abs(paisa) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The shop whose statement is the richest (most rows), and one that has reversed vouchers left out. */
async function pickShops(): Promise<{ busiest: Lookup; withReversed: Lookup }> {
  const shops = (await api.get<Lookup[]>("/customers?limit=100")).slice(0, 40);
  let busiest: { shop: Lookup; rows: number } | null = null;
  let withReversed: Lookup | null = null;
  for (const shop of shops) {
    const s = await api.get<Statement>(`/customers/${shop.id}/statement`);
    if (!busiest || s.rows.length > busiest.rows) busiest = { shop, rows: s.rows.length };
    if (!withReversed && s.omittedReversed > 0) withReversed = shop;
  }
  return { busiest: busiest!.shop, withReversed: withReversed! };
}

async function readScreen(page: import("@playwright/test").Page) {
  const table = page.getByTestId("statement-table");
  const rows = await table.locator("tbody tr[data-testid=statement-row]").evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())),
  );
  return {
    rows,
    debit: paisaOf(await page.getByTestId("statement-total-debit").innerText()),
    credit: paisaOf(await page.getByTestId("statement-total-credit").innerText()),
    closing: await page.getByTestId("statement-closing").innerText(),
    opening: await page.getByTestId("statement-opening").innerText(),
  };
}

test("a shop's statement on screen equals the API's: every row, the totals, opening and closing (full range and a date window)", async ({ open }) => {
  const { page } = await open("OWNER");
  const { busiest } = await pickShops();
  for (const window of [{ q: "", url: "" }, { q: "?from=2026-03-01&to=2026-07-31", url: "&period=custom&from=2026-03-01&to=2026-07-31" }]) {
    const expected = await api.get<Statement>(`/customers/${busiest.id}/statement${window.q}`);
    await page.goto(`/statements?type=customer&partyId=${busiest.id}${window.url}`);
    await expect(page.getByTestId("statement-party")).toHaveText(busiest.name);
    await expect(page.getByTestId("statement-closing")).toBeVisible();
    const screen = await readScreen(page);
    expect(expected.rows.length).toBeGreaterThan(3);
    expect(screen.rows).toHaveLength(expected.rows.length);
    expected.rows.forEach((r, i) => {
      const cells = screen.rows[i]!;
      expect(cells[1], `row ${i} ref`).toBe(r.ref);
      // S9 added the Qty column after Description, so debit / credit / balance moved one to the right (deliberate change of S5's indices)
      expect(cells[2], `row ${i} description = the invoice's detail, else the ledger wording`).toBe(r.detail ?? r.description);
      expect(cells[3], `row ${i} qty`).toBe(r.qtyLabel);
      expect(paisaOf(cells[4] || "0"), `row ${i} debit`).toBe(r.debitP);
      expect(paisaOf(cells[5] || "0"), `row ${i} credit`).toBe(r.creditP);
      expect(paisaOf(cells[6]!) * (cells[6]!.endsWith("Cr") ? -1 : 1), `row ${i} balance`).toBe(r.balanceP);
    });
    expect(screen.debit).toBe(expected.totals.debitP);
    expect(screen.credit).toBe(expected.totals.creditP);
    expect(screen.closing).toContain(`PKR ${money(expected.closing)}`);
    expect(screen.opening).toContain(`PKR ${money(expected.opening)}`);
    // opening + debits − credits = closing, on the paper
    expect(expected.opening + screen.debit - screen.credit).toBe(expected.closing);
  }
});

test("a supplier's statement: sign in words, and it equals the API", async ({ open }) => {
  const { page } = await open("OWNER");
  const sup = await findParty(api, "suppliers", SCENARIO.supplier.name);
  const expected = await api.get<Statement>(`/suppliers/${sup.id}/statement`);
  await page.goto(`/statements?type=supplier&partyId=${sup.id}`);
  await expect(page.getByTestId("statement-party")).toHaveText(SCENARIO.supplier.name);
  const screen = await readScreen(page);
  expect(screen.rows).toHaveLength(expected.rows.length);
  expect(screen.debit).toBe(expected.totals.debitP);
  expect(screen.credit).toBe(expected.totals.creditP);
  expect(screen.closing).toContain(expected.closing > 0 ? `We owe supplier PKR ${money(expected.closing)}` : `PKR ${money(expected.closing)}`);
  await expect(page.getByText("A balance without a mark means we owe the supplier")).toBeVisible();
});

test("a credit balance is said in words and marked Cr — never a bare negative number", async ({ open }) => {
  const { page } = await open("OWNER");
  const hotel = await findParty(api, "customers", SCENARIO.hotel.name);
  await api.postOk("/payments/receive", { customerId: hotel.id, amountP: 100_000 });
  expect(await balanceOf(api, "customers", hotel.id)).toBe(-100_000);
  await page.goto(`/statements?type=customer&partyId=${hotel.id}`);
  await expect(page.getByTestId("statement-closing")).toContainText("We owe the shop PKR 1,000.00 (credit)");
  await expect(page.getByTestId("statement-table").locator("tbody tr[data-testid=statement-row]").last().locator("td").last()).toHaveText("1,000.00 Cr");
  await expect(page.getByTestId("statement")).not.toContainText("-1,000");
});

test("reversed vouchers are left out and the page says how many", async ({ open }) => {
  const { page } = await open("OWNER");
  const { withReversed } = await pickShops();
  const expected = await api.get<Statement>(`/customers/${withReversed.id}/statement`);
  await page.goto(`/statements?type=customer&partyId=${withReversed.id}`);
  await expect(page.getByTestId("statement-omitted")).toHaveText(`${expected.omittedReversed} reversed voucher${expected.omittedReversed === 1 ? " is" : "s are"} not shown.`);
});

test("the filter bar: shops of one area only, the address keeps the screen, Clear resets, a bad range is said", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/statements");
  await expect(page.getByText("Choose a shop to see its statement")).toBeVisible();
  await expect(page.getByTestId("statement")).toHaveCount(0); // nothing is shown until a shop is chosen

  const regions = await api.get<{ id: string; nameEn: string }[]>("/regions");
  const region = regions.find((r) => r.nameEn === "Barawal")!;
  const inRegion = await api.get<Lookup[]>(`/customers?regionId=${region.id}&limit=100`);
  expect(inRegion.length).toBeGreaterThan(0);
  await page.getByLabel("Area").selectOption({ label: "Barawal" });
  await expect(page).toHaveURL(new RegExp(`region=${region.id}`));
  const combo = page.getByRole("combobox", { name: "Shop" });
  await combo.click();
  const offered = await page.getByRole("listbox").getByRole("option").allInnerTexts();
  expect(offered.length).toBe(Math.min(20, inRegion.length)); // the picker lists up to 20 matches, all of them from this area
  for (const name of inRegion.slice(0, 20).map((c) => c.name)) expect(offered.join("\n")).toContain(name);
  await page.getByRole("listbox").getByRole("option").first().click();
  await expect(page.getByTestId("statement")).toBeVisible();

  await page.getByLabel("Date", { exact: true }).selectOption({ label: "Custom range…" });
  await page.getByLabel("From", { exact: true }).fill("2026-06-01");
  await page.getByLabel("To", { exact: true }).fill("2026-05-01");
  await expect(page.getByText("The “From” date is after the “To” date")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue("custom");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-06-01");
  await expect(page.getByTestId("statement")).toHaveCount(0); // an impossible range shows no statement (and asks the server nothing)

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Choose a shop to see its statement")).toBeVisible();

  // switching to suppliers drops the shop
  await page.getByLabel("Suppliers").check({ force: true });
  await expect(page).toHaveURL(/type=supplier/);
  await expect(page.getByRole("combobox", { name: "Supplier" })).toHaveValue("");
});

test("This month / a preset is computed from the business date", async ({ open }) => {
  const { page } = await open("OWNER");
  const { busiest } = await pickShops();
  await page.goto(`/statements?type=customer&partyId=${busiest.id}`);
  await page.getByLabel("Date", { exact: true }).selectOption({ label: "Last 12 months" });
  // "Last 12 months" = 365 days back from the business date: 24 Sep 2025 to 24 Sep 2026 on the day this was written
  await expect(page.getByTestId("statement-period")).toHaveText(/^\d{2} [A-Z][a-z]{2} 202\d to \d{2} [A-Z][a-z]{2} 202\d$/);
  const text = await page.getByTestId("statement-period").innerText();
  const [from, to] = text.split(" to ") as [string, string];
  expect((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000).toBe(365);
});

test("Download CSV: BOM, one line per row, spreadsheet-safe", async ({ open }) => {
  const { page } = await open("OWNER");
  const { busiest } = await pickShops();
  const expected = await api.get<Statement>(`/customers/${busiest.id}/statement`);
  await page.goto(`/statements?type=customer&partyId=${busiest.id}`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  const raw = readFileSync(await download.path()!, "utf8");
  expect(raw.charCodeAt(0)).toBe(0xfeff);
  const table = parseCsv(raw.slice(1)).filter((r) => r.length > 1);
  expect(table[0]).toEqual(["Date", "Ref", "Description", "Qty", "Debit", "Credit", "Balance"]); // S9: + Qty
  expect(table).toHaveLength(expected.rows.length + 1);
  expected.rows.forEach((r, i) => {
    expect(table[i + 1]![2], `csv row ${i} description`).toBe(r.detail ?? r.description);
    expect(table[i + 1]![3], `csv row ${i} qty`).toBe(r.qtyLabel);
  });
});
