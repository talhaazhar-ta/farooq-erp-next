import { readFileSync } from "node:fs";
import { test, expect, apiAs, allPayments, paymentsList, paisaOf, parseCsv, type Api } from "./fixtures";

/**
 * The Payments list against the real server: what the screen claims (counts, rows, "read as" lines) is checked against what
 * the API returns for the same filters. The expected figures are read from the API at test time (other specs move money).
 */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
});

const countLine = (page: import("@playwright/test").Page) => page.getByTestId("count-line");
const rows = (page: import("@playwright/test").Page) => page.getByTestId("payment-row");

test("tab counts and totals are the server's facets; each tab lists exactly its count", async ({ open }) => {
  const { page } = await open("OWNER");
  const facets = (await paymentsList(api, "status=POSTED&limit=1")).facets;
  await page.goto("/payments");
  await expect(rows(page).first()).toBeVisible();

  const all = facets.received.count + facets.paidToShops.count + facets.paidToSuppliers.count;
  await expect(page.getByTestId("tab-count-all")).toHaveText(String(all));
  await expect(page.getByTestId("tab-count-received")).toHaveText(String(facets.received.count));
  await expect(page.getByTestId("tab-count-paidToShops")).toHaveText(String(facets.paidToShops.count));
  await expect(page.getByTestId("tab-count-paidToSuppliers")).toHaveText(String(facets.paidToSuppliers.count));
  await expect(page.getByTestId("tab-count-reversed")).toHaveText(String(facets.reversed.count));

  for (const [tab, count] of [
    ["received", facets.received.count],
    ["paidToShops", facets.paidToShops.count],
    ["paidToSuppliers", facets.paidToSuppliers.count],
    ["reversed", facets.reversed.count],
  ] as const) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
    await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
    await expect(rows(page)).toHaveCount(Math.min(50, count));
    // the kind tabs and the rows under them are the same set: every row says the tab's kind
    if (tab !== "reversed") {
      const label = { received: "Received from shop", paidToShops: "Paid to shop", paidToSuppliers: "Paid to supplier" }[tab];
      for (const cell of await rows(page).locator("td:nth-child(4)").allInnerTexts()) expect(cell.trim()).toBe(label);
    } else {
      await expect(rows(page).first()).toContainText("Reversed");
    }
  }
});

test("paging: 50 a page, Next / Previous, and the address keeps the page across a reload and Back", async ({ open }) => {
  const { page } = await open("OWNER");
  const posted = await paymentsList(api, "status=POSTED&limit=200");
  await page.goto("/payments");
  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByTestId("page-range")).toHaveText(`Showing 1–50 of ${posted.total}`);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByTestId("page-number")).toContainText("Page 2 of");
  await expect(page.getByTestId("page-range")).toHaveText(`Showing 51–100 of ${posted.total}`);
  await expect(rows(page).first()).toHaveAttribute("data-number", posted.items[50]!.receiptNumber);

  await page.reload();
  await expect(page.getByTestId("page-number")).toContainText("Page 2 of");
  await expect(rows(page).first()).toHaveAttribute("data-number", posted.items[50]!.receiptNumber);

  await page.goBack();
  await expect(page.getByTestId("page-number")).toContainText("Page 1 of");
  await expect(rows(page).first()).toHaveAttribute("data-number", posted.items[0]!.receiptNumber);
});

test("sort: highest amount first, lowest first, oldest first — in the server's order", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/payments");
  for (const [label, sort] of [["Highest amount", "high"], ["Lowest amount", "low"], ["Oldest first", "oldest"]] as const) {
    await page.getByLabel("Sort by").selectOption({ label });
    await expect(page).toHaveURL(new RegExp(`sort=${sort}`));
    const expected = (await paymentsList(api, `status=POSTED&sort=${sort}&limit=10`)).items.map((p) => p.receiptNumber);
    await expect.poll(async () => (await rows(page).evaluateAll((els) => els.slice(0, 10).map((e) => e.getAttribute("data-number")))).join()).toBe(expected.join());
  }
  await page.getByLabel("Sort by").selectOption({ label: "Newest first" });
  await expect(page).not.toHaveURL(/sort=/); // the default leaves the address
});

test("words match in any order (AND), a phrase from the shop name and the receipt number narrows to one", async ({ open }) => {
  const { page } = await open("OWNER");
  const target = (await allPayments(api, "status=POSTED")).find((p) => /^[A-Za-z]+ [A-Za-z]+/.test(p.partyNameSnapshot ?? ""))!;
  const [w1, w2] = target.partyNameSnapshot!.split(" ") as [string, string];
  await page.goto("/payments");
  await page.getByLabel("Search payments").fill(`${w2} ${w1}`.toUpperCase()); // reversed order, other case
  const expected = await paymentsList(api, `status=POSTED&q=${encodeURIComponent(`${w2} ${w1}`)}&limit=1`);
  await expect(countLine(page)).toContainText(`${expected.total} of`);
  expect(expected.total).toBeGreaterThan(0);
  await page.getByLabel("Search payments").fill(`${w2} ${w1} ${target.receiptNumber}`);
  await expect(rows(page).first()).toHaveAttribute("data-number", target.receiptNumber);
  await expect(countLine(page)).toContainText("1 of");
});

test("Urdu letter variants find each other (ک / ك, ی / ي)", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/payments");
  const totals: number[] = [];
  for (const word of ["کریم", "كريم"]) {
    // Persian ke + Persian ye, then Arabic kaf + Arabic yeh
    await page.getByLabel("Search payments").fill(word);
    const expected = (await paymentsList(api, `status=POSTED&q=${encodeURIComponent(word)}&limit=1`)).total;
    await expect(countLine(page)).toContainText(`${expected} of`);
    totals.push(expected);
  }
  expect(totals[0]).toBeGreaterThan(0);
  expect(totals[1]).toBe(totals[0]);
});

test("a typed day-first date is read, said out loud, and replaces the date filter", async ({ open }) => {
  const { page } = await open("OWNER");
  const day = (await paymentsList(api, "status=POSTED&limit=1")).items[0]!.paymentDate; // the newest voucher's day
  const [y, m, d] = day.split("-") as [string, string, string];
  const label = `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y}`;
  const typed = `${d}/${m}/${y}`;

  await page.goto("/payments");
  await page.getByLabel("Search payments").fill(typed);
  await expect(page.getByTestId("search-read-as")).toHaveText(`“${typed}” is read as ${label} (day / month / year).`);
  const expected = (await paymentsList(api, `status=POSTED&from=${day}&to=${day}&limit=1`)).total;
  await expect(countLine(page)).toContainText(`${expected} of`);
  for (const cell of await rows(page).locator("td:nth-child(2)").allInnerTexts()) expect(cell.trim()).toBe(label);

  // with a date filter already chosen, the line says the typed date won
  await page.getByLabel("Date", { exact: true }).selectOption({ label: "Last 30 days" });
  await expect(page.getByTestId("search-read-as")).toHaveText(`“${typed}” is read as ${label} (day / month / year) — this replaces the date filter.`);
});

test("'Search in' narrows where words are looked for: an invoice number is found in Invoice scope, not in Shop scope", async ({ open }) => {
  const { page } = await open("OWNER");
  const applied = (await allPayments(api, "status=POSTED")).find((p) => p.appliedTo.length > 0)!;
  const inv = applied.appliedTo[0]!;
  await page.goto("/payments");
  await page.getByLabel("Search in").selectOption({ label: "Search: invoice / purchase no." });
  await page.getByLabel("Search payments").fill(inv);
  await expect(page).toHaveURL(/q=/); // the search has been sent (the newest vouchers are on screen even before it)
  await expect(page.locator(`[data-testid=payment-row][data-number="${applied.receiptNumber}"]`)).toBeVisible();
  await page.getByLabel("Search in").selectOption({ label: "Search: shop or supplier / phone" });
  await expect(page.getByText("No payments match")).toBeVisible();
});

test("amount range: every row inside it, and the count is the server's for the same paisa bounds", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/payments");
  await page.getByLabel("Amount from").fill("1,000");
  await page.getByLabel("Amount to").fill("2,000.50");
  const expected = (await paymentsList(api, "status=POSTED&minP=100000&maxP=200050&limit=1")).total;
  await expect(countLine(page)).toContainText(`${expected} of`);
  const amounts = (await rows(page).locator("td:nth-child(7)").allInnerTexts()).map(paisaOf);
  expect(amounts.length).toBeGreaterThan(0);
  for (const a of amounts) {
    expect(a).toBeGreaterThanOrEqual(100_000);
    expect(a).toBeLessThanOrEqual(200_050);
  }
});

test("inputs that can never match are said out loud — never a quietly wrong list", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = false;
  const { page } = await open("OWNER");
  await page.goto("/payments");
  // minimum above maximum → the server's own warning
  await page.getByLabel("Amount from").fill("5,000");
  await page.getByLabel("Amount to").fill("1,000");
  await expect(page.getByTestId("search-problem")).toContainText("minimum amount is above the maximum");
  await expect(page.getByText("No payments match")).toBeVisible();
  // more than two decimals → refused at the edge, nothing sent
  await page.getByLabel("Amount from").fill("12.345");
  await expect(page.getByTestId("amount-problem")).toContainText("at most 2 decimal");
  // From after To
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await page.getByLabel("Date", { exact: true }).selectOption({ label: "Custom range…" });
  await page.getByLabel("From", { exact: true }).fill("2026-09-10");
  await page.getByLabel("To", { exact: true }).fill("2026-09-01");
  await expect(page.getByTestId("search-problem")).toContainText("“From” date is after the “To” date");
});

test("typing sends one request after a pause, not one per key; Clear filters puts everything back", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/payments");
  await expect(rows(page).first()).toBeVisible();
  const before = (await page.locator("[data-testid=count-line]").innerText()).trim();
  let requests = 0;
  page.on("request", (r) => {
    if (/\/payments\?/.test(r.url())) requests++;
  });
  await page.getByLabel("Search payments").pressSequentially("noor", { delay: 40 });
  await expect(page).toHaveURL(/q=noor/);
  await expect(countLine(page)).toContainText(" of ");
  expect(requests).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByLabel("Search payments")).toHaveValue("");
  await expect(countLine(page)).toHaveText(before);
});

test("no match is a real screen with a way out", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/payments?q=zzzzqqqq");
  await expect(page.getByText("No payments match")).toBeVisible();
  await expect(countLine(page)).toContainText("0 of");
  await page.getByRole("main").getByRole("button", { name: "Clear filters" }).last().click();
  await expect(rows(page).first()).toBeVisible();
});

test("region filter: the server's count, and a note that suppliers drop out", async ({ open }) => {
  const { page } = await open("OWNER");
  const regions = await api.get<{ id: string; nameEn: string }[]>("/regions");
  const region = regions.find((r) => r.nameEn === "Drosh")!;
  await page.goto("/payments");
  await page.getByLabel("Region").selectOption({ label: "Drosh" });
  const expected = (await paymentsList(api, `status=POSTED&regionId=${region.id}&limit=1`)).total;
  await expect(countLine(page)).toContainText(`${expected} of`);
  await expect(page.getByText("A region belongs to a shop, so payments to suppliers are left out")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`region=${region.id}`));
});

test("Export CSV: every match (not one page), UTF-8 BOM, the server's file name", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/payments?tab=reversed");
  await expect(rows(page).first()).toBeVisible();
  const expected = await allPayments(api, "status=REVERSED");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^farooq-co-payments-\d{4}-\d{2}-\d{2}\.csv$/);
  const raw = readFileSync(await download.path()!, "utf8");
  expect(raw.charCodeAt(0)).toBe(0xfeff);
  const table = parseCsv(raw.slice(1));
  const header = table[0]!;
  expect(header[0]).toBe("Number");
  const noCol = 0;
  const body = table.slice(1).filter((r) => r.length > 1);
  expect(body).toHaveLength(expected.length);
  expect(new Set(body.map((r) => r[noCol]))).toEqual(new Set(expected.map((p) => p.receiptNumber)));
  await expect(page.getByTestId("toast").first()).toContainText("Downloaded farooq-co-payments-");
});

test("a row opens its voucher; an Urdu shop name is shown as printed", async ({ open }) => {
  const { page } = await open("OWNER");
  const isUrdu = (t: string | null) => [...(t ?? "")].some((c) => c.charCodeAt(0) >= 0x600 && c.charCodeAt(0) <= 0x6ff);
  const urdu = (await allPayments(api, "status=POSTED")).find((p) => isUrdu(p.partyNameSnapshot))!;
  await page.goto("/payments?q=" + encodeURIComponent(urdu.receiptNumber));
  const row = rows(page).first();
  await expect(row).toHaveAttribute("data-number", urdu.receiptNumber);
  await expect(row).toContainText(urdu.partyNameSnapshot!);
  await expect(row.locator("td:nth-child(3) span").first()).toHaveAttribute("dir", "auto");
  await row.getByRole("link", { name: urdu.receiptNumber }).click();
  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("voucher-number")).toHaveText(urdu.receiptNumber);
});
