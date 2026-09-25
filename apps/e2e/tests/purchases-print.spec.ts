import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
// pdf.js (Mozilla) reads the PDF Chromium prints: the assertions are about the page that would come out of the printer
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Page } from "@playwright/test";
import { PURCHASE_PRINT_LABELS, type PurchaseDetail, type PurchasePrint } from "@farooq/shared";
import { test, expect, apiAs, findParty, postPurchase, productByName, purchasesList, expectNoHorizontalScroll, ARTIFACTS_DIR, PURCHASE_PRODUCTS, SCENARIO, type Api } from "./fixtures";

/**
 * S13: the printed purchase (legacy `DocModel.purchase`, standard A4 sheet), read back from the PDF Chromium prints: one page, the number,
 * the supplier, the strip with the bags ORDERED and RECEIVED apart (fix 4), the lines, the totals, the words — paper colours in the dark
 * theme and none of the app's chrome. This spec owns the Multan supplier: a part delivery of two lines into both godowns with charges and a voucher.
 */

let api: Api;
let P: PurchaseDetail;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const whs = await api.get<{ id: string; active: boolean }[]>("/warehouses");
  const wheat = await productByName(api, PURCHASE_PRODUCTS.wheat.en);
  const bran = await productByName(api, PURCHASE_PRODUCTS.bran.en);
  P = await postPurchase(api, {
    supplierId: (await findParty(api, "suppliers", SCENARIO.supMultan.name)).id,
    lines: [
      { productId: wheat.id, quantity: 100, receivedQuantity: 60, unitPriceP: 51_000, warehouseId: whs[0]!.id },
      { productId: bran.id, quantity: 12.5, unitPriceP: 28_000, discountP: 5_000, warehouseId: whs[1]!.id },
    ],
    freightP: 45_000,
    loadingP: 12_500,
    paidAmountP: 2_000_000,
    supplierInvoiceNo: "MUL-88",
    vehicleNo: "MUL-4040",
    notes: "دو بوری پھٹی ہوئی",
  });
});

async function printedPdf(page: Page, name: string): Promise<{ pages: number; text: string }> {
  await page.emulateMedia({ media: "print" });
  const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  writeFileSync(path.join(ARTIFACTS_DIR, `${name}.pdf`), buffer);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
  }
  return { pages: doc.numPages, text };
}
const collapse = (s: string) => s.replace(/\s+/g, " ");
const squeeze = (s: string) => s.replace(/\s+/g, "");
const model = (id: string): Promise<PurchasePrint> => api.get(`/purchases/${id}/print`);
const NO_CHROME = ["Sign out", "Dark mode", "Light mode", "Back to purchase", "All purchases"];

test("one A4 page: number, supplier, ordered AND received bags (fix 4), lines, totals, words, the voucher — and no app chrome", async ({ open }) => {
  const { page } = await open("OWNER", { width: 900, height: 1200 });
  const m = await model(P.id);
  await page.goto(`/purchases/${P.id}`);
  await page.getByRole("link", { name: "Print" }).click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${P.id}/print$`));
  await expect(page.getByTestId("purchase-print-number")).toHaveText(m.number);
  await expect(page.getByTestId("purchase-party")).toHaveText(SCENARIO.supMultan.name);
  await expect(page.getByTestId("purchase-line")).toHaveCount(2);
  const strip = await page.getByTestId("purchase-strip").locator("> div").evaluateAll((els) => els.map((e) => [e.querySelector("i")!.textContent, e.querySelector("b")!.textContent]));
  expect(strip).toEqual(m.strip.map((s) => [s.label, s.value]));
  expect(m.strip.find((s) => s.label === "Bags ordered")!.value).toBe("112.5");
  expect(m.strip.find((s) => s.label === "Bags received")!.value).toBe("72.5");
  const totals = await page.getByTestId("purchase-totals").locator("tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent)));
  expect(totals).toEqual(m.totals.map((t) => [t.label, t.text]));

  const { pages, text } = await printedPdf(page, "purchase-standard");
  expect(pages).toBe(1);
  const flat = collapse(text);
  const sq = squeeze(text);
  expect(sq).toContain(squeeze(PURCHASE_PRINT_LABELS.title));
  expect(flat).toContain(m.number);
  expect(flat).toContain(SCENARIO.supMultan.name);
  for (const s of m.strip) {
    expect(sq.toLowerCase(), s.label).toContain(squeeze(s.label).toLowerCase()); // the strip's captions are upper-cased by the CSS
    expect(flat, s.label).toContain(s.value);
  }
  for (const c of ["Ordered", "Received", "Rate", "Amount"]) expect(sq.toLowerCase(), c).toContain(c.toLowerCase());
  for (const r of m.rows) {
    expect(flat).toContain(r.description);
    expect(flat).toContain(r.amount);
  }
  for (const t of m.totals) {
    expect(flat, t.label).toContain(t.text);
    expect(sq.toLowerCase(), t.label).toContain(squeeze(t.label).toLowerCase());
  }
  expect(sq).toContain(squeeze(m.amountInWords)); // pdf.js splits some kerned pairs ("Tw enty")
  expect(flat).toContain(m.payments[0]!.receiptNumber);
  for (const s of m.signatures) expect(sq.toLowerCase()).toContain(squeeze(s).toLowerCase());
  for (const chrome of NO_CHROME) expect(flat, chrome).not.toContain(chrome);
});

test("dark theme: the sheet is still black on white; a phone does not scroll sideways", async ({ open }) => {
  const dark = await open("OWNER", { theme: "dark" });
  await dark.page.goto(`/purchases/${P.id}/print`);
  const paper = dark.page.getByTestId("purchase-paper");
  await expect(paper).toBeVisible();
  const colours = await paper.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  expect(colours.bg).toBe("rgb(255, 255, 255)");
  expect(colours.fg).not.toBe("rgb(255, 255, 255)");
  const phone = await open("OWNER", { width: 390, height: 844 });
  await phone.page.goto(`/purchases/${P.id}/print`);
  await expect(phone.page.getByTestId("purchase-paper")).toBeVisible();
  await expectNoHorizontalScroll(phone.page);
});

test("a cancelled purchase prints with the CANCELLED ribbon, on one page", async ({ open }) => {
  const { page } = await open("OWNER", { width: 900, height: 1200 });
  const c = (await purchasesList(api, "q=PUR-2026-900090&limit=5")).items[0]!;
  await page.goto(`/purchases/${c.id}/print`);
  await expect(page.getByTestId("purchase-ribbon")).toHaveText("CANCELLED");
  const { pages, text } = await printedPdf(page, "purchase-cancelled");
  expect(pages).toBe(1);
  expect(squeeze(text)).toContain("CANCELLED");
});
