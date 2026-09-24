import { mkdirSync, writeFileSync } from "node:fs";
// pdf.js (Mozilla) reads the PDF Chromium prints, so the assertions are about the PAGE THAT WOULD COME OUT OF THE PRINTER
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Page } from "@playwright/test";
import type { Receipt } from "@farooq/shared";
import { test, expect, apiAs, allPayments, findParty, postInvoice, expectNoHorizontalScroll, ARTIFACTS_DIR, shot, SCENARIO, type Api } from "./fixtures";
import path from "node:path";

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
});

async function printedPdf(page: Page, name: string): Promise<{ pages: number; text: string; perPage: string[] }> {
  await page.emulateMedia({ media: "print" });
  const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  writeFileSync(path.join(ARTIFACTS_DIR, `${name}.pdf`), buffer);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false }).promise;
  let text = "";
  const perPage: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const t = content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
    perPage.push(t);
    text += t;
  }
  return { pages: doc.numPages, text, perPage };
}

const collapse = (s: string) => s.replace(/\s+/g, " ");
const hasArabicScript = (s: string) => [...s].some((c) => (c.charCodeAt(0) >= 0x600 && c.charCodeAt(0) <= 0x6ff) || (c.charCodeAt(0) >= 0xfb50 && c.charCodeAt(0) <= 0xfeff));

test("a receipt prints on ONE page with its number, amount and amount in words, and none of the app chrome", async ({ open }) => {
  const { page } = await open("OWNER", { width: 900, height: 1200 });
  const shop = await findParty(api, "customers", SCENARIO.juliet.name);
  const voucher = await api.postOk("/payments/receive", { customerId: shop.id, amountP: 500_000, method: "Cash", reference: "PRINT-1", note: "printed by the e2e test" });
  const model = await api.get<Receipt>(`/payments/${voucher.id}/receipt`);

  await page.goto(`/payments/${voucher.id}/receipt`);
  await expect(page.getByTestId("receipt-number")).toHaveText(voucher.receiptNumber);
  // "Print" asks the browser to print
  await page.evaluate(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => void ((window as unknown as { __printed: number }).__printed += 1);
  });
  await page.getByRole("button", { name: "Print" }).click();
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

  const { pages, text } = await printedPdf(page, "receipt");
  expect(pages).toBe(1);
  const flat = collapse(text);
  expect(flat).toContain(voucher.receiptNumber);
  expect(flat).toContain("PAYMENT RECEIPT");
  expect(flat).toContain("5,000.00");
  expect(flat).toContain(model.amountInWords); // "Five Thousand Rupees Only"
  expect(flat).toContain(model.company.businessName!);
  expect(flat).toContain("RECEIVED FROM");
  expect(flat).toContain(SCENARIO.juliet.name);
  expect(flat).toContain("Previous balance");
  expect(flat).toContain("Authorised signature");
  // the app's own navigation is not on the paper
  expect(flat).not.toContain("Sign out");
  expect(flat).not.toContain("Dark mode");
  expect(flat).not.toContain("Statements");
  expect(flat).not.toContain("View statement");
  // the Urdu labels are on the paper as glyphs (a missing font would print boxes; extraction would still show the code points, so
  // this proves the labels are there, and the screenshots prove the glyphs)
  expect(hasArabicScript(text)).toBe(true);

  await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 794, height: 1123 }); // A4 at 96 dpi: the closest screenshot to the printed sheet
  await page.screenshot({ path: shot("receipt-print-preview-a4"), fullPage: true });
});

test("the paper keeps its own colours: a dark-theme screen prints (and previews) black on white", async ({ open }) => {
  const { page } = await open("OWNER", { theme: "dark" });
  const any = (await allPayments(api, "status=POSTED&direction=received"))[0]!;
  await page.goto(`/payments/${any.id}/receipt`);
  const paper = page.getByTestId("receipt");
  await expect(paper).toBeVisible();
  const colours = await paper.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  expect(colours).toEqual({ bg: "rgb(255, 255, 255)", fg: "rgb(17, 17, 17)" });
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark"); // the screen around it IS dark
  await page.emulateMedia({ media: "print" });
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
});

test("a supplier voucher says PAYMENT VOUCHER / PAID TO", async ({ open }) => {
  const { page } = await open("OWNER");
  const sup = (await allPayments(api, "status=POSTED&direction=paidToSuppliers"))[0]!;
  await page.goto(`/payments/${sup.id}/receipt`);
  await expect(page.getByTestId("receipt-title")).toHaveText("PAYMENT VOUCHER");
  const { pages, text } = await printedPdf(page, "voucher-supplier");
  expect(pages).toBe(1);
  expect(collapse(text)).toContain("PAID TO");
  expect(collapse(text)).toContain(sup.receiptNumber);
});

test("a reversed voucher prints stamped REVERSED, with the reason and no balances", async ({ open }) => {
  const { page } = await open("OWNER");
  const rev = (await allPayments(api, "status=REVERSED&direction=received"))[0]!;
  await page.goto(`/payments/${rev.id}/receipt`);
  await expect(page.getByTestId("reversed-mark")).toContainText("REVERSED");
  await expect(page.getByTestId("receipt-prev")).toHaveCount(0);
  await expect(page.getByTestId("receipt-remaining")).toHaveCount(0);
  const { pages, text } = await printedPdf(page, "receipt-reversed");
  expect(pages).toBe(1);
  expect(collapse(text)).toContain("REVERSED");
  expect(collapse(text)).not.toContain("Previous balance");
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.screenshot({ path: shot("receipt-reversed-print-preview-a4"), fullPage: true });
});

test("every voucher on file prints on one page (the fullest one, and the Urdu-named ones)", async ({ open }) => {
  const { page } = await open("OWNER");
  const all = await allPayments(api, "");
  const fullest = [...all].sort((a, b) => b.appliedTo.length - a.appliedTo.length)[0]!;
  const isUrdu = (t: string | null) => [...(t ?? "")].some((c) => c.charCodeAt(0) >= 0x600 && c.charCodeAt(0) <= 0x6ff);
  const urdu = all.filter((p) => isUrdu(p.partyNameSnapshot)).slice(0, 3);
  for (const p of [fullest, ...urdu]) {
    await page.emulateMedia({ media: "screen" });
    await page.goto(`/payments/${p.id}/receipt`);
    await expect(page.getByTestId("receipt-number")).toHaveText(p.receiptNumber);
    const { pages } = await printedPdf(page, `check-${p.receiptNumber}`);
    expect(pages, `${p.receiptNumber} printed pages`).toBe(1);
  }
});

test("the statement prints with its table header, on paper colours, without the filter bar — and a long one repeats the header on every page", async ({ open }) => {
  const { page } = await open("OWNER", { theme: "dark" });
  // a shop with a long statement (about 50 rows), so the table certainly runs over more than one printed page
  const oscar = await findParty(api, "customers", SCENARIO.oscar.name);
  for (let i = 0; i < 50; i++) await postInvoice(api, { customerId: oscar.id, qty: 1 + (i % 5), date: `2026-05-${10 + (i % 15)}` }); // dated inside the window the statements spec looks at
  const st = await api.get<{ rows: { ref: string }[] }>(`/customers/${oscar.id}/statement`);
  expect(st.rows.length).toBeGreaterThanOrEqual(50);
  await page.goto(`/statements?type=customer&partyId=${oscar.id}`);
  await expect(page.getByTestId("statement")).toBeVisible();
  const { pages, text, perPage } = await printedPdf(page, "statement");
  expect(pages).toBeGreaterThanOrEqual(2);
  const flat = collapse(text);
  expect(flat).toContain("Statement of account");
  expect(flat).toContain("Closing balance");
  expect(flat).not.toContain("Sign out");
  expect(flat).not.toContain("Account statements"); // the screen heading and the filter bar are not on the paper
  // the header row (with the new Qty column) is repeated on every printed page that carries table rows
  let withRows = 0;
  perPage.forEach((t) => {
    if (!st.rows.some((r) => t.includes(r.ref))) return;
    withRows++;
    const squeezed = t.replace(/\s+/g, "");
    expect(squeezed).toContain("Description");
    expect(squeezed).toContain("Qty");
  });
  expect(withRows).toBeGreaterThanOrEqual(2);
  expect(await page.getByTestId("statement-table").locator("thead").evaluate((el) => getComputedStyle(el).display)).toBe("table-header-group");
});
