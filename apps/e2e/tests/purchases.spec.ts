import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { formatPaisaPlain, ROLES, type PurchaseDetail, type Role } from "@farooq/shared";
import { readState } from "../setup/env";
import {
  test,
  expect,
  apiAs,
  balanceOf,
  findParty,
  paisaOf,
  parseCsv,
  postPurchase,
  productByName,
  purchaseDetailOf,
  purchasesList,
  statementOf,
  PURCHASE_PRODUCTS,
  SCENARIO,
  type Api,
} from "./fixtures";

/**
 * S13: the purchase list, the view page and who may open them, driven in Chromium against the built API. The purchases this spec reads
 * are its own, made through the API in `beforeAll` for its own suppliers (Karachi, Lahore, Quetta) and the purchase-only products;
 * every figure on a screen is compared with what the API says.
 *   A  Karachi: 40 wheat ordered / 25 arrived + 10 maida (all arrived), freight Rs 200, Rs 1,000 paid with it, bill KHI-501, lorry KHI-9090
 *   B  Lahore:  30 bran ordered, nothing arrived yet
 *   C  کوئٹہ ملز: 5 maida
 */

let api: Api;
let A: PurchaseDetail;
let B: PurchaseDetail;
let C: PurchaseDetail;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
  const wheat = await productByName(api, PURCHASE_PRODUCTS.wheat.en);
  const maida = await productByName(api, PURCHASE_PRODUCTS.maida.en);
  const bran = await productByName(api, PURCHASE_PRODUCTS.bran.en);
  const sup = async (name: string) => (await findParty(api, "suppliers", name)).id;
  A = await postPurchase(api, {
    supplierId: await sup(SCENARIO.supKarachi.name),
    lines: [
      { productId: wheat.id, quantity: 40, receivedQuantity: 25, unitPriceP: 52_000 },
      { productId: maida.id, quantity: 10, unitPriceP: 61_050 },
    ],
    freightP: 20_000,
    paidAmountP: 100_000,
    supplierInvoiceNo: "KHI-501",
    vehicleNo: "KHI-9090",
    driver: "Nawaz",
  });
  B = await postPurchase(api, { supplierId: await sup(SCENARIO.supLahore.name), lines: [{ productId: bran.id, quantity: 30, receivedQuantity: 0, unitPriceP: 30_000 }] });
  C = await postPurchase(api, { supplierId: await sup(SCENARIO.supQuetta.name), lines: [{ productId: maida.id, quantity: 5, unitPriceP: 60_000 }] });
});

const nav = (page: Page) => page.getByRole("navigation", { name: "Main", exact: true });
const box = (page: Page) => page.getByLabel("Search purchases");
const rowsOf = (page: Page) => page.getByTestId("purchase-row");
/** Waits for the list to show the answer to the current address (the previous rows stay while a search loads). */
async function settled(page: Page): Promise<void> {
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
}

/* ── who ────────────────────────────────────────────────────────────────────────────────────── */

for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as Role[]) {
  test(`${role}: Purchases is in the nav and opens the list with its cards`, async ({ open }) => {
    const { page } = await open(role);
    await page.goto("/");
    await nav(page).getByRole("link", { name: "Purchases" }).click();
    await expect(page).toHaveURL(/\/purchases$/);
    await expect(page.getByRole("heading", { name: "Purchases", level: 1 })).toBeVisible();
    await expect(rowsOf(page).first()).toBeVisible();
    await expect(page.getByTestId("kpis")).toBeVisible();
  });
}

test("the warehouse role and Sales: no Purchases in the nav, the not-available panel on every purchase URL, and 403 from the API", async ({ open }) => {
  for (const role of ["INVENTORY", "SALES"] as Role[]) {
    const { page } = await open(role);
    await page.goto("/");
    await expect(nav(page).getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Purchases" })).toHaveCount(0);
    for (const url of ["/purchases", `/purchases/${A.id}`, `/purchases/${A.id}/print`]) {
      await page.goto(url);
      await expect(page.getByTestId("not-available")).toContainText(`Not available for the ${role === "SALES" ? "Sales" : "Warehouse"} role`);
      await expect(rowsOf(page)).toHaveCount(0);
      await expect(page.getByTestId("purchase-paper")).toHaveCount(0);
    }
  }
  const state = readState();
  for (const role of ROLES) {
    const cookie = `fc_sid=${JSON.parse(readFileSync(state.users[role].storageState, "utf8")).cookies[0].value as string}`;
    for (const path of ["/purchases?limit=1", `/purchases/${A.id}`, `/purchases/${A.id}/print`, "/purchases/export.csv"]) {
      const res = await fetch(`${state.apiUrl}${path}`, { headers: { cookie } });
      expect(res.status, `${role} ${path}`).toBe(role === "INVENTORY" || role === "SALES" ? 403 : 200);
    }
  }
});

/* ── the list ───────────────────────────────────────────────────────────────────────────────── */

test("the cards and the count line are the API's (fix 4: the first card counts the bags RECEIVED)", async ({ open }) => {
  const { page } = await open("OWNER");
  const r = await purchasesList(api, "limit=1");
  await page.goto("/purchases");
  await expect(page.getByTestId("kpi-bags")).toHaveText(r.kpis.receivedQuantity.toLocaleString("en-US"));
  await expect(page.getByTestId("kpi-bags-note")).toContainText(`${r.kpis.count} purchases`);
  await expect(page.getByTestId("kpi-bags-note")).toContainText(`${r.kpis.orderedQuantity.toLocaleString("en-US")} ordered`);
  await expect(page.getByTestId("kpi-value")).toHaveText(formatPaisaPlain(r.kpis.valueP));
  await expect(page.getByTestId("kpi-owed")).toHaveText(formatPaisaPlain(r.kpis.owedP));
  await expect(page.getByTestId("kpi-suppliers")).toHaveText(String(r.kpis.suppliers));
  await expect(page.getByTestId("count-line")).toContainText(`${r.onFile} purchases on file`);
});

test("search by the supplier: one row, drawn as the API says (bags received of ordered, balance, payment, supplier's bill)", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/purchases");
  await box(page).fill("karachi flour");
  await expect(page).toHaveURL(/q=karachi/);
  await settled(page);
  await expect(rowsOf(page)).toHaveCount(1);
  const row = rowsOf(page).first();
  await expect(row).toHaveAttribute("data-number", A.number!);
  await expect(row.getByTestId("row-bags")).toHaveText("35 of 50");
  await expect(row.getByTestId("row-balance")).toHaveText(formatPaisaPlain(A.balanceP));
  await expect(row).toContainText("KHI-501");
  await expect(row).toContainText("Partial");
  await expect(row).toContainText("Partly received");
  await expect(page.getByTestId("count-line")).toContainText("1 of");
});

test("every word must be found, in any order; the vehicle, the driver, the number and a product line (with why it matched)", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/purchases");
  for (const [typed, number] of [["9090 khi", A.number], ["nawaz", A.number], [A.number!, A.number], ["lahore bran", B.number]] as const) {
    await box(page).fill(typed);
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(typed.split(" ")[0]!)}`));
    await settled(page);
    await expect(rowsOf(page), typed).toHaveCount(1);
    await expect(rowsOf(page).first()).toHaveAttribute("data-number", number!);
  }
  // a product word the header does not explain: the row says which line
  await box(page).fill("E2E Purchase Maida");
  await expect(page).toHaveURL(/q=E2E/);
  await settled(page);
  const api2 = await purchasesList(api, `q=${encodeURIComponent("E2E Purchase Maida")}&limit=50`);
  await expect(rowsOf(page)).toHaveCount(api2.items.length);
  // "e2e" is in the supplier's name (not "why"); "purchase" and "maida" are not — so every line holding either is listed, as the API says
  const hit = api2.items.find((i) => i.id === A.id)!.hits!;
  expect(hit.lines.map((l) => l.name)).toContain("E2E Purchase Maida 50KG");
  await expect(page.locator(`[data-number="${A.number}"]`).getByTestId("row-hits")).toHaveText(hit.lines.map((l) => `${l.name} × ${l.quantity.toLocaleString("en-US")}`).join(" · "));
});

test("an Urdu supplier name typed with the other letter forms (ی / ي, ک / ك) is found", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/purchases");
  const typed = "كوئٹہ ملز".replace(/ی/g, "ي");
  await box(page).fill(typed);
  await expect(page).toHaveURL(/q=/);
  await settled(page);
  const r = await purchasesList(api, `q=${encodeURIComponent(SCENARIO.supQuetta.name)}&limit=50`);
  expect(r.items.map((i) => i.number)).toContain(C.number);
  expect((await purchasesList(api, `q=${encodeURIComponent(typed)}&limit=50`)).items.map((i) => i.id)).toEqual(r.items.map((i) => i.id));
  expect(await rowsOf(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-number")))).toEqual(r.items.map((i) => i.number));
});

test("a typed date is a filter and the screen says how it read it", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/purchases");
  await box(page).fill("05/08/2026");
  await expect(page.getByTestId("search-read-as")).toContainText("05 Aug 2026");
  await expect(page).toHaveURL(/q=05/);
  await settled(page);
  const r = await purchasesList(api, "q=05%2F08%2F2026&limit=50");
  await expect(rowsOf(page)).toHaveCount(r.items.length);
  await expect(page.locator('[data-number="PUR-2026-900001"]')).toBeVisible();
});

test("payment, category and warehouse filters, the sort — the rows are the API's, in its order; Clear filters", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/purchases");
  await page.getByLabel("Category").selectOption({ label: PURCHASE_PRODUCTS.bran.cat });
  await expect(page).toHaveURL(/category=/);
  await settled(page);
  const bran = await purchasesList(api, `category=${encodeURIComponent(PURCHASE_PRODUCTS.bran.cat)}&limit=50`);
  expect(bran.items.map((i) => i.number)).toContain(B.number); // B, and the print spec's two-line purchase (its second line is bran)
  expect(await rowsOf(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-number")))).toEqual(bran.items.map((i) => i.number));

  await page.getByLabel("Category").selectOption({ label: PURCHASE_PRODUCTS.maida.cat });
  await page.getByLabel("Payment").selectOption("UNPAID");
  await page.getByLabel("Sort by").selectOption("high");
  await expect(page).toHaveURL(/pay=UNPAID/);
  await expect(page).toHaveURL(/sort=high/);
  await settled(page);
  const r = await purchasesList(api, `category=${encodeURIComponent(PURCHASE_PRODUCTS.maida.cat)}&paymentStatus=UNPAID&sort=high&limit=50`);
  expect(await rowsOf(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-number")))).toEqual(r.items.map((i) => i.number));
  expect(r.items.map((i) => i.number)).toContain(C.number);
  expect(r.items.map((i) => i.number)).not.toContain(A.number); // part-paid
  // the address keeps it: reload shows the same
  await page.reload();
  await settled(page);
  await expect(rowsOf(page)).toHaveCount(r.items.length);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/purchases$/);
});

test("CSV: the server's file name, a byte-order mark, every match of the filters", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/purchases?q=e2e");
  await settled(page);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^farooq-co-purchases-\d{4}-\d{2}-\d{2}\.csv$/);
  const raw = readFileSync((await download.path())!, "utf8");
  expect(raw.charCodeAt(0)).toBe(0xfeff);
  const rows = parseCsv(raw.slice(1)).filter((r) => r.length > 1);
  const r = await purchasesList(api, "q=e2e&limit=1");
  expect(rows[0]!.slice(0, 3)).toEqual(["Purchase", "Date", "Supplier ref"]);
  expect(rows.length - 1).toBe(r.total);
  const a = rows.find((x) => x[0] === A.number)!;
  expect(a.slice(7, 9)).toEqual(["50", "35"]); // ordered, received
});

/* ── the view page ──────────────────────────────────────────────────────────────────────────── */

test("view: lines ordered / received, totals, the voucher linked, the supplier's balance, the cost block, and the server's reasons", async ({ open }) => {
  const { page } = await open("OWNER");
  const d = await purchaseDetailOf(api, A.id);
  await page.goto("/purchases");
  await box(page).fill(A.number!);
  await settled(page);
  await rowsOf(page).first().getByRole("link", { name: A.number! }).click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${A.id}$`));
  await expect(page.getByTestId("purchase-number")).toHaveText(A.number!);
  const lines = page.getByTestId("line-row");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0).getByTestId("line-ordered")).toHaveText("40");
  await expect(lines.nth(0).getByTestId("line-received")).toHaveText("25");
  await expect(page.getByTestId("purchase-bags")).toHaveText("35 received of 50 ordered");
  expect(paisaOf(await page.getByTestId("grand-total").innerText())).toBe(d.totalP);
  expect(paisaOf(await page.getByTestId("paid-total").innerText())).toBe(d.paidP);
  expect(paisaOf(await page.getByTestId("balance-total").innerText())).toBe(d.balanceP);
  const supId = d.supplierId!;
  expect(paisaOf(await page.getByTestId("supplier-balance").innerText())).toBe(await balanceOf(api, "suppliers", supId));
  await expect(page.getByTestId("cost-block")).toBeVisible(); // the owner holds PROFIT_VIEW
  await expect(page.getByTestId("reason-change-supplier")).toHaveText(d.actions.changeSupplier.reason!);
  await expect(page.getByTestId("action-change-supplier")).toBeDisabled();
  await expect(page.getByTestId("stock-row")).toHaveCount(d.stockMovements.length);
  // the voucher paid with the bill opens
  const pv = d.payments[0]!;
  await page.getByRole("link", { name: pv.receiptNumber }).click();
  await expect(page).toHaveURL(new RegExp(`/payments/${pv.paymentId}$`));
});

test("view: an order nothing has arrived for, and a cancelled purchase", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto(`/purchases/${B.id}`);
  await expect(page.getByTestId("ordered-banner")).toBeVisible();
  await expect(page.getByTestId("no-stock")).toContainText("Nothing has arrived");
  await expect(page.getByTestId("reason-change-supplier")).toHaveText("Editing a purchase on screen is not available yet."); // allowed by the server; no form yet
  const cancelled = (await purchasesList(api, "q=PUR-2026-900090&limit=5")).items[0]!;
  await page.goto(`/purchases/${cancelled.id}`);
  await expect(page.getByTestId("cancelled-banner")).toBeVisible();
  await expect(page.getByTestId("reason-edit")).toHaveText("A cancelled purchase cannot be edited.");
});

test("a supplier statement's purchase row opens the purchase (readers of purchases only)", async ({ open }) => {
  const d = await purchaseDetailOf(api, A.id);
  const st = await statementOf(api, "suppliers", d.supplierId!);
  expect(st.rows.some((r) => r.ref === A.number)).toBe(true);
  const { page } = await open("ACCOUNTANT");
  await page.goto(`/statements?type=supplier&partyId=${d.supplierId}`);
  const link = page.getByTestId("statement-purchase-link").filter({ hasText: A.number! }).first();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${A.id}$`));
  // Sales reads statements but not purchases: the number is plain text there
  const sales = await open("SALES");
  await sales.page.goto(`/statements?type=supplier&partyId=${d.supplierId}`);
  await expect(sales.page.getByTestId("statement-row").first()).toBeVisible();
  await expect(sales.page.getByTestId("statement-purchase-link")).toHaveCount(0);
});
