import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { INVOICE_STATUSES, INVOICE_STATUS_LABELS } from "@farooq/shared";
import { test, expect, apiAs, allInvoices, invoicesList, invoiceDetailOf, paisaOf, parseCsv, type Api } from "./fixtures";

/**
 * The Invoices list against the real server: what the screen claims (cards, counts, rows, "read as" lines) is checked against
 * what the API returns for the same filters. Expected figures are read from the API at test time.
 */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

const rows = (page: Page) => page.getByTestId("invoice-row");
const countLine = (page: Page) => page.getByTestId("count-line");
const box = (page: Page) => page.getByLabel("Search invoices");
const numbersOnScreen = (page: Page, n = 10) => rows(page).evaluateAll((els, k) => els.slice(0, k).map((e) => e.getAttribute("data-number")), n);

test("the four cards, the count line and the status picker are the server's numbers", async ({ open }) => {
  const { page } = await open("OWNER");
  const r = await invoicesList(api, "limit=1");
  await page.goto("/invoices");
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByTestId("kpi-count")).toHaveText(String(r.kpis.count));
  await expect(page.getByTestId("kpi-count-note")).toContainText(`${r.kpis.drafts} draft`);
  expect(paisaOf(await page.getByTestId("kpi-invoiced").innerText())).toBe(r.kpis.invoicedP);
  expect(paisaOf(await page.getByTestId("kpi-received").innerText())).toBe(r.kpis.receivedP);
  expect(paisaOf(await page.getByTestId("kpi-outstanding").innerText())).toBe(r.kpis.outstandingP);
  await expect(countLine(page)).toContainText(`${r.onFile} invoices on file`);
  for (const s of INVOICE_STATUSES) {
    await expect(page.getByRole("option", { name: `${INVOICE_STATUS_LABELS[s]} (${r.statusFacets[s].count})`, exact: true })).toHaveCount(1);
  }
  // the dataset really has every status the screen must handle
  for (const s of ["DRAFT", "CONFIRMED", "DISPATCHED", "PARTIALLY_PAID", "PAID", "CANCELLED", "PARTIALLY_RETURNED"] as const) expect(r.statusFacets[s].count, s).toBeGreaterThan(0);
});

test("picking a status lists exactly its count, and the cards follow the filter", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices");
  await expect(rows(page).first()).toBeVisible();
  for (const status of ["PAID", "CANCELLED", "DRAFT"] as const) {
    const expected = await invoicesList(api, `status=${status}&limit=1`);
    await page.getByLabel("Status").selectOption(status);
    await expect(page).toHaveURL(new RegExp(`status=${status}`));
    await expect(countLine(page)).toContainText(`${expected.total} of ${expected.onFile}`);
    await expect(rows(page)).toHaveCount(Math.min(50, expected.total));
    for (const s of await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(s).toBe(status);
    await expect(page.getByTestId("kpi-count")).toHaveText(String(expected.kpis.count));
  }
  // drafts and cancelled invoices are left out of the money cards (server rule), only "drafts on file" counts drafts
  const cancelled = await invoicesList(api, "status=CANCELLED&limit=1");
  expect(cancelled.kpis.invoicedP).toBe(0);
  await page.getByLabel("Status").selectOption("");
  await expect(page).not.toHaveURL(/status=/);
});

test("words match in any order and any case (AND); a draft is listed as 'Draft'", async ({ open }) => {
  const { page } = await open("OWNER");
  const target = (await allInvoices(api)).find((i) => /^[A-Za-z]+ [A-Za-z]+/.test(i.shopName ?? ""))!;
  const [w1, w2] = target.shopName!.split(" ") as [string, string];
  await page.goto("/invoices");
  const typed = `${w2} ${w1}`.toUpperCase();
  await box(page).fill(typed);
  const expected = await invoicesList(api, `q=${encodeURIComponent(typed)}&limit=1`);
  expect(expected.total).toBeGreaterThan(0);
  await expect(countLine(page)).toContainText(`${expected.total} of`);
  await box(page).fill(`${w2} ${w1} ${target.number}`);
  await expect(rows(page).first()).toHaveAttribute("data-number", target.number!);
  await expect(countLine(page)).toContainText("1 of");

  await box(page).fill("");
  await page.getByLabel("Status").selectOption("DRAFT");
  await expect(rows(page).first().getByRole("link", { name: "Draft" })).toBeVisible();
});

test("Urdu letter variants find each other (ک / ك, ی / ي) in names and products", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices");
  const totals: number[] = [];
  for (const word of ["کریم", "كريم"]) {
    await box(page).fill(word);
    const expected = (await invoicesList(api, `q=${encodeURIComponent(word)}&limit=1`)).total;
    await expect(countLine(page)).toContainText(`${expected} of`);
    totals.push(expected);
  }
  expect(totals[0]).toBeGreaterThan(0);
  expect(totals[1]).toBe(totals[0]);
});

test("a typed day-first date is read, said out loud, and replaces the date filter", async ({ open }) => {
  const { page } = await open("OWNER");
  const day = (await invoicesList(api, "limit=1")).items[0]!.date;
  const [y, m, d] = day.split("-") as [string, string, string];
  const label = `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y}`;
  const typed = `${d}/${m}/${y}`;
  await page.goto("/invoices?period=last30");
  await box(page).fill(typed);
  await expect(page.getByTestId("search-read-as")).toHaveText(`“${typed}” is read as ${label} (day / month / year) — this replaces the date filter.`);
  const expected = await invoicesList(api, `q=${encodeURIComponent(typed)}&limit=1`);
  await expect(countLine(page)).toContainText(`${expected.total} of`);
  expect(expected.total).toBeGreaterThan(0);
  for (const dt of await rows(page).locator("td:nth-child(2)").allInnerTexts()) expect(dt.trim()).toBe(label);
});

test("'Search in': a receipt number is found only in its own scope (and Everything does not find it)", async ({ open }) => {
  const { page } = await open("OWNER");
  const paid = (await allInvoices(api, "status=PAID")).find((i) => i.paidP > 0)!;
  const receipt = (await invoiceDetailOf(api, paid.id)).receipts.find((r) => r.status === "POSTED")!.receiptNumber;
  await page.goto("/invoices");
  await box(page).fill(receipt);
  const everything = await invoicesList(api, `q=${encodeURIComponent(receipt)}&limit=1`);
  await expect(countLine(page)).toContainText(`${everything.total} of`);
  await page.getByLabel("Search in", { exact: true }).selectOption({ label: "Search: Receipt / payment ref." });
  await expect(page).toHaveURL(/scope=payment/);
  const scoped = await invoicesList(api, `q=${encodeURIComponent(receipt)}&scope=payment&limit=200`);
  expect(scoped.items.map((i) => i.id)).toContain(paid.id);
  await expect(countLine(page)).toContainText(`${scoped.total} of`);
  // the reason it matched is drawn under the number: "Paid by REC-…"
  await expect(rows(page).filter({ hasText: paid.number! }).getByTestId("row-hits")).toContainText(`Paid by ${receipt}`);
});

test("a product search says which line matched (× bags · +n more)", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices");
  await page.getByLabel("Search in", { exact: true }).selectOption({ label: "Search: Product" });
  await box(page).fill("sella");
  const expected = await invoicesList(api, "q=sella&scope=product&limit=50");
  expect(expected.total).toBeGreaterThan(0);
  await expect(countLine(page)).toContainText(`${expected.total} of`);
  const first = expected.items[0]!;
  const hit = first.hits!.lines[0]!;
  await expect(rows(page).first().getByTestId("row-hits")).toContainText(`${hit.name} × ${Number(hit.quantity.toFixed(3))}`);
});

test("total from / to are typed in rupees and match the server's paisa filter", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices");
  await page.getByLabel("Total from").fill("20,000");
  await page.getByLabel("Total to").fill("60000");
  const expected = await invoicesList(api, "minP=2000000&maxP=6000000&limit=200");
  await expect(countLine(page)).toContainText(`${expected.total} of`);
  for (const t of await rows(page).locator("td:nth-child(7)").allInnerTexts()) {
    const p = paisaOf(t);
    expect(p).toBeGreaterThanOrEqual(2_000_000);
    expect(p).toBeLessThanOrEqual(6_000_000);
  }
  await page.getByLabel("Total from").fill("abc");
  await expect(page.getByTestId("amount-problem")).toBeVisible();
});

test("an impossible range is said out loud and the list is empty on purpose", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices?period=custom&from=2026-09-01&to=2026-03-01");
  await expect(page.getByTestId("search-problem")).toContainText("The “From” date is after the “To” date, so no invoice can match.");
  await expect(page.getByText("No invoices match")).toBeVisible();
});

test("sorts: newest, oldest, highest, lowest total and highest balance due are in the server's order", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices");
  await expect(rows(page).first()).toBeVisible();
  for (const [label, sort] of [["Highest total", "high"], ["Lowest total", "low"], ["Oldest first", "oldest"], ["Highest balance due", "due"]] as const) {
    await page.getByLabel("Sort by").selectOption({ label });
    await expect(page).toHaveURL(new RegExp(`sort=${sort}`));
    const expected = (await invoicesList(api, `sort=${sort}&limit=10`)).items.map((i) => i.number ?? "");
    await expect.poll(async () => (await numbersOnScreen(page)).join()).toBe(expected.join());
  }
  await page.getByLabel("Sort by").selectOption({ label: "Newest first" });
  await expect(page).not.toHaveURL(/sort=/);
});

test("paging: 50 a page, Next / Previous, and the address keeps the page across a reload and Back", async ({ open }) => {
  const { page } = await open("OWNER");
  const all = await invoicesList(api, "limit=200");
  await page.goto("/invoices");
  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByTestId("page-range")).toHaveText(`Showing 1–50 of ${all.total}`);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByTestId("page-range")).toHaveText(`Showing 51–100 of ${all.total}`);
  await expect(rows(page).first()).toHaveAttribute("data-number", all.items[50]!.number ?? "");
  await page.reload();
  await expect(page.getByTestId("page-number")).toContainText("Page 2 of");
  await expect(rows(page).first()).toHaveAttribute("data-number", all.items[50]!.number ?? "");
  await page.goBack();
  await expect(page.getByTestId("page-number")).toContainText("Page 1 of");
  await expect(rows(page).first()).toHaveAttribute("data-number", all.items[0]!.number ?? "");
});

test("a date preset is arithmetic on the business date, sent as from / to; Clear filters resets everything", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices");
  await page.getByLabel("Date", { exact: true }).selectOption({ label: "Last 12 months" });
  await page.getByLabel("Status").selectOption("PAID");
  await box(page).fill("zam");
  await expect(page).toHaveURL(/period=lastyear/);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/invoices$/);
  await expect(box(page)).toHaveValue("");
  await expect(page.getByLabel("Status")).toHaveValue("");
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue("all");
});

test("an unmatched search shows the empty state, with a way out", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices?q=zzzzqqqq");
  await expect(page.getByText("No invoices match")).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Clear filters" }).last().click();
  await expect(rows(page).first()).toBeVisible();
});

test("Export CSV: every match (no paging), BOM, the server's file name, one row per invoice", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices?status=PAID");
  await expect(rows(page).first()).toBeVisible();
  const expected = await allInvoices(api, "status=PAID");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^farooq-co-invoices-\d{4}-\d{2}-\d{2}\.csv$/);
  const raw = readFileSync(await download.path()!, "utf8");
  expect(raw.charCodeAt(0)).toBe(0xfeff);
  const table = parseCsv(raw.slice(1)).filter((r) => r.length > 1);
  expect(table).toHaveLength(expected.length + 1); // every match, not just the first 50
  expect(expected.length).toBeGreaterThan(0);
  const numberCol = table[0]!.findIndex((h) => /invoice/i.test(h));
  expect(table.slice(1).map((r) => r[numberCol]).sort()).toEqual(expected.map((i) => i.number ?? "").sort());
});

test("keeps the previous rows visible while the next answer loads (no blank flash)", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/invoices");
  await expect(rows(page).first()).toBeVisible();
  await page.route("**/invoices?*", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.getByLabel("Sort by").selectOption({ label: "Oldest first" });
  await expect(rows(page).first()).toBeVisible(); // still drawn while the slow answer is on its way
  await expect(page.getByRole("status").filter({ hasText: "Updating" })).toBeVisible();
});
