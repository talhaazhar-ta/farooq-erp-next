import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
// pdf.js (Mozilla) reads the PDF Chromium prints, so the assertions are about the PAGE THAT WOULD COME OUT OF THE PRINTER
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Page } from "@playwright/test";
import { CLASSIC_LABELS, INVOICE_PRINT_LABELS, type InvoicePrint, type ProductPickItem } from "@farooq/shared";
import { test, expect, apiAs, allInvoices, invoiceDetailOf, findParty, stockBasics, expectNoHorizontalScroll, ARTIFACTS_DIR, shot, SCENARIO, type Api } from "./fixtures";

/**
 * The printed invoice, both layouts, read back from the PDF Chromium prints: one page, the number, the shop, the totals, the ledger
 * rows, the Urdu labels, the ribbons, and none of the app's chrome. The model is fetched from the API and compared with what is on the sheet.
 */

let api: Api;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
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
/** Letter-spaced headings ("C A N C E L L E D") come out of the PDF with gaps between the letters: compare without any whitespace. */
const squeeze = (s: string) => s.replace(/\s+/g, "");
const hasArabicScript = (s: string) => [...s].some((c) => (c.charCodeAt(0) >= 0x600 && c.charCodeAt(0) <= 0x6ff) || (c.charCodeAt(0) >= 0xfb50 && c.charCodeAt(0) <= 0xfeff));
const model = (id: string, template = ""): Promise<InvoicePrint> => api.get(`/invoices/${id}/print${template ? `?template=${template}` : ""}`);
const NO_CHROME = ["Sign out", "Dark mode", "Light mode", "Back to invoice", "Classic layout", "Standard layout", "All invoices"];

/** A confirmed / part-paid invoice with a Latin shop name and at least one receipt (so the ledger, payments and totals all have something in them). */
async function richInvoice() {
  for (const item of await allInvoices(api)) {
    if (!item.number || !item.customerId || !/^[A-Za-z]/.test(item.shopName ?? "") || item.status === "CANCELLED" || item.paidP <= 0) continue;
    const m = await model(item.id);
    if (m.classic.ledgerRows.length >= 2 && m.payments.length >= 1) return { item, m };
  }
  throw new Error("no suitable invoice in the dataset");
}

test("classic layout (the live setting): one page, number, shop, ledger rows, lines, the six-row box, Urdu labels — and none of the app chrome", async ({ open }) => {
  const { page } = await open("OWNER", { width: 900, height: 1200 });
  const { item, m } = await richInvoice();
  expect(m.template).toBe("classic"); // the business's own setting when nothing is asked for
  await page.goto(`/invoices/${item.id}/print`);
  await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", "classic");

  // on the screen: the model, drawn as it came
  await expect(page.getByTestId("invoice-invno")).toHaveText(m.classic.invNo);
  await expect(page.getByTestId("invoice-party")).toHaveText(m.party.shop!);
  await expect(page.getByTestId("classic-ledger-row")).toHaveCount(m.classic.ledgerRows.length);
  const ledgerCells = await page.getByTestId("classic-ledger-row").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent)));
  expect(ledgerCells).toEqual(m.classic.ledgerRows.map((r) => [r.date, r.dr, r.cr]));
  await expect(page.getByTestId("invoice-line")).toHaveCount(m.rows.length);
  const box = await page.getByTestId("classic-box").locator("> div").evaluateAll((els) => els.map((e) => e.textContent));
  expect(box).toHaveLength(6); // Gross / Opening / Total / Cash / (blank) / Balance
  expect(box).toEqual(m.classic.box.map((b) => `${b.label}${b.labelUr}${b.text}`));
  expect(m.classic.box[4]!.label).toBe(""); // the fifth is blank on the shop's own sheet
  // the Urdu labels are printed from the constants, not retyped
  const screenText = await page.getByTestId("invoice-paper").innerText();
  for (const [, ur] of CLASSIC_LABELS.box) if (ur) expect(screenText).toContain(ur);
  expect(screenText).toContain(CLASSIC_LABELS.ledger.dateUr);
  expect(screenText).toContain(CLASSIC_LABELS.trademarkUr);

  // on paper
  const { pages, text } = await printedPdf(page, "invoice-classic");
  expect(pages).toBe(1);
  const flat = collapse(text);
  expect(flat).toContain(m.classic.invNo);
  expect(flat).toContain(m.party.shop!);
  expect(flat).toContain(CLASSIC_LABELS.billToParty);
  for (const label of ["Gross Amounts:", "Opening", "Total :", "Cash Amt:", "Balance", CLASSIC_LABELS.ledger.subtotal, "Product", "Price", "Quantity", "Amounts"]) expect(flat, label).toContain(label);
  for (const b of m.classic.box) if (b.text) expect(flat, `box ${b.label}`).toContain(b.text);
  for (const r of m.classic.ledgerRows) expect(flat).toContain(r.date);
  expect(flat).toContain(m.classic.lineTotal);
  expect(flat).toContain(`${Number(m.classic.qtyTotal).toLocaleString("en-US")}.00`);
  for (const r of m.rows) expect(flat).toContain(r.amount);
  expect(hasArabicScript(text)).toBe(true);
  for (const chrome of NO_CHROME) expect(flat, chrome).not.toContain(chrome);
  await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.screenshot({ path: shot("invoice-classic-print-preview-a4"), fullPage: true });
});

test("standard layout: one page, the same model — invoice details, totals, amount in words, previous balance, payments", async ({ open }) => {
  const { page } = await open("OWNER", { width: 900, height: 1200 });
  const { item } = await richInvoice();
  const m = await model(item.id, "standard");
  expect(m.template).toBe("standard");
  await page.goto(`/invoices/${item.id}/print?template=standard`);
  await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", "standard");
  await expect(page.getByTestId("invoice-number")).toHaveText(m.number);
  await expect(page.getByTestId("invoice-line")).toHaveCount(m.rows.length);
  await expect(page.getByTestId("invoice-words")).toContainText(m.amountInWords);
  // the totals table is the model's, row by row, in order
  const totals = await page.getByTestId("invoice-totals").locator("tr").evaluateAll((trs) => trs.map((tr) => (tr.lastElementChild?.textContent ?? "").trim()));
  expect(totals).toEqual(m.totals.map((t) => t.text));
  // meta rows with an empty value are not drawn (the legacy renderer skipped them)
  const metaLabels = await page.locator(".fc-meta tr td:first-child").allInnerTexts();
  expect(metaLabels).toEqual(m.meta.filter((r) => r.value).map((r) => r.label));

  const { pages, text } = await printedPdf(page, "invoice-standard");
  expect(pages).toBe(1);
  const flat = collapse(text);
  for (const s of [m.number, m.party.shop!, INVOICE_PRINT_LABELS.meta, "Grand total", "Amount Paid", INVOICE_PRINT_LABELS.totals.balance, INVOICE_PRINT_LABELS.words, m.amountInWords, "Previous balance", "Current outstanding balance", "Payments against this document", "Received by (shopkeeper)", "Authorised signature", ...m.payments.map((p) => p.receiptNumber)]) {
    expect(squeeze(text).toLowerCase(), s).toContain(squeeze(s).toLowerCase()); // letter-spaced headings come out of the PDF with gaps
  }
  for (const t of m.totals) expect(flat, t.label).toContain(t.text);
  expect(hasArabicScript(text)).toBe(true);
  for (const chrome of NO_CHROME) expect(flat, chrome).not.toContain(chrome);
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.screenshot({ path: shot("invoice-standard-print-preview-a4"), fullPage: true });
});

test("the layout switch and the Print button: the address keeps the layout, Print asks the browser to print once", async ({ open }) => {
  const { page } = await open("OWNER");
  const { item } = await richInvoice();
  await page.goto(`/invoices/${item.id}/print`);
  await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", "classic");
  await page.getByLabel("Standard layout").check({ force: true });
  await expect(page).toHaveURL(/template=standard/);
  await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", "standard");
  await page.reload();
  await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", "standard");
  await page.getByLabel("Classic layout").check({ force: true });
  await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", "classic");
  await page.evaluate(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => void ((window as unknown as { __printed: number }).__printed += 1);
  });
  await page.getByRole("button", { name: "Print" }).click();
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  await page.getByRole("link", { name: "← Back to invoice" }).click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${item.id}$`));
  // a nonsense layout in the address falls back to the business's own
  await page.goto(`/invoices/${item.id}/print?template=<script>`);
  await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", "classic");
});

for (const template of ["classic", "standard"] as const) {
  test(`a DRAFT prints with the DRAFT ribbon and no number (${template})`, async ({ open }) => {
    const { page } = await open("OWNER");
    const draft = (await allInvoices(api, "status=DRAFT"))[0]!;
    const m = await model(draft.id, template);
    expect(m.isDraft).toBe(true);
    expect(m.hasNumber).toBe(false);
    await page.goto(`/invoices/${draft.id}/print?template=${template}`);
    await expect(page.getByTestId("invoice-ribbon")).toHaveText(m.labels.ribbon.draft);
    const { pages, text } = await printedPdf(page, `invoice-draft-${template}`);
    expect(pages).toBe(1);
    const flat = collapse(text);
    expect(squeeze(text)).toContain("DRAFT");
    expect(flat).not.toMatch(/INV-\d{4}-\d{6}/); // it has no number
    if (template === "classic") await expect(page.getByTestId("invoice-invno")).toContainText("000000");
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.screenshot({ path: shot(`invoice-draft-${template}-print-preview-a4`), fullPage: true });
  });

  test(`a CANCELLED invoice prints with the CANCELLED ribbon (${template})`, async ({ open }) => {
    const { page } = await open("OWNER");
    const cancelled = (await allInvoices(api, "status=CANCELLED")).find((i) => i.number)!; // (an earlier spec discarded a draft, which has no number)
    const m = await model(cancelled.id, template);
    expect(m.cancelled).toBe(true);
    await page.goto(`/invoices/${cancelled.id}/print?template=${template}`);
    await expect(page.getByTestId("invoice-ribbon")).toHaveText(m.labels.ribbon.cancelled);
    const { pages, text } = await printedPdf(page, `invoice-cancelled-${template}`);
    expect(pages).toBe(1);
    expect(squeeze(text)).toContain("CANCELLED");
    expect(squeeze(text)).toContain(cancelled.number!);
  });
}

test("the paper keeps its own colours: a dark-theme screen prints (and previews) black on white", async ({ open }) => {
  const { page } = await open("OWNER", { theme: "dark" });
  const { item } = await richInvoice();
  for (const template of ["classic", "standard"]) {
    await page.emulateMedia({ media: "screen" });
    await page.goto(`/invoices/${item.id}/print?template=${template}`);
    const paper = page.getByTestId("invoice-paper");
    await expect(paper).toBeVisible();
    const colours = await paper.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
    expect(colours).toEqual({ bg: "rgb(255, 255, 255)", fg: "rgb(22, 22, 31)" });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark"); // the screen around it IS dark
    await page.emulateMedia({ media: "print" });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
    await page.emulateMedia({ media: "screen" });
    await expectNoHorizontalScroll(page);
  }
});

test("every kind of invoice on file prints on ONE page in both layouts (a sample of each status, the biggest, an Urdu-named one)", async ({ open }) => {
  const { page } = await open("OWNER");
  const all = await allInvoices(api);
  const pickBy = (s: string) => all.filter((i) => i.status === s).slice(0, 2);
  const biggest = [...all].sort((a, b) => b.itemCount - a.itemCount)[0]!;
  const urdu = all.filter((i) => [...(i.shopName ?? "")].some((c) => c.charCodeAt(0) >= 0x600 && c.charCodeAt(0) <= 0x6ff)).slice(0, 2);
  const sample = new Map<string, (typeof all)[number]>();
  for (const i of [...["DRAFT", "CONFIRMED", "PARTIALLY_PAID", "PAID", "CANCELLED", "DISPATCHED", "PARTIALLY_RETURNED"].flatMap(pickBy), biggest, ...urdu]) sample.set(i.id, i);
  expect(sample.size).toBeGreaterThan(8);
  for (const i of sample.values()) {
    for (const template of ["classic", "standard"]) {
      await page.emulateMedia({ media: "screen" });
      await page.goto(`/invoices/${i.id}/print?template=${template}`);
      await expect(page.getByTestId("invoice-paper")).toHaveAttribute("data-template", template);
      const { pages } = await printedPdf(page, `check-${i.number ?? "draft"}-${template}`);
      expect(pages, `${i.number ?? "draft"} (${i.status}) ${template}`).toBe(1);
    }
  }
});

test("a long invoice (45 lines) runs onto more pages, and the table header repeats on every one", async ({ open }) => {
  const { page } = await open("OWNER");
  const lima = await findParty(api, "customers", SCENARIO.lima.name);
  const { warehouse } = await stockBasics(api);
  const products = await api.get<ProductPickItem[]>(`/products?warehouseId=${warehouse.id}&limit=20`);
  expect(products.length).toBeGreaterThanOrEqual(14);
  const inv = await api.postOk<{ id: string }>("/invoices", {
    mode: "post",
    customerId: lima.id,
    warehouseId: warehouse.id,
    lines: Array.from({ length: 45 }, (_, i) => ({ productId: products[i % 14]!.id, quantity: 1 + (i % 7), unitPriceP: 100_000 + i * 1_000 })),
    idempotencyKey: `e2e-long-${Date.now()}`,
  });
  expect((await invoiceDetailOf(api, inv.id)).lines).toHaveLength(45);
  for (const template of ["classic", "standard"]) {
    await page.emulateMedia({ media: "screen" });
    await page.goto(`/invoices/${inv.id}/print?template=${template}`);
    await expect(page.getByTestId("invoice-line")).toHaveCount(45);
    const { pages, text } = await printedPdf(page, `invoice-long-${template}`);
    expect(pages, template).toBeGreaterThanOrEqual(2);
    expect(pages, template).toBeLessThanOrEqual(3);
    // the lines table runs onto the next page, and its header is drawn again there
    expect((squeeze(text).toUpperCase().match(template === "classic" ? /QUANTITY/g : /DESCRIPTION/g) ?? []).length, `${template} header repeats`).toBeGreaterThanOrEqual(2);
    const heads = await page.locator("thead").evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
    for (const d of heads) expect(d).toBe("table-header-group");
  }
});

test("the print page on a phone: no page-level sideways scroll (the sheet scrolls inside its own box)", async ({ open }) => {
  const { page } = await open("OWNER", { width: 390, height: 844 });
  const { item } = await richInvoice();
  for (const template of ["classic", "standard"]) {
    await page.goto(`/invoices/${item.id}/print?template=${template}`);
    await expect(page.getByTestId("invoice-paper")).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});
