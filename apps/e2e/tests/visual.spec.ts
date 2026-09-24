import { mkdirSync } from "node:fs";
import { test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Role } from "@farooq/shared";
import { readState } from "../setup/env";
import { addProduct, chooseShop, fillLine } from "./builder-helpers";
import { test, expect, apiAs, allPayments, allInvoices, invoiceDetailOf, findParty, expectNoHorizontalScroll, shot, ARTIFACTS_DIR, SCENARIO, type Api } from "./fixtures";

/**
 * Every screen at desktop (1280), phone (390) and in the dark theme, screenshotted into e2e-artifacts/ (gitignored) to be LOOKED AT,
 * with the machine-checkable parts asserted: no page-level horizontal scroll, nothing wider than the viewport, no console errors.
 */

const VARIANTS = [
  { key: "desktop", width: 1280, height: 860, theme: "light" as const },
  { key: "phone", width: 390, height: 844, theme: "light" as const },
  { key: "dark", width: 1280, height: 860, theme: "dark" as const },
  { key: "phone-dark", width: 390, height: 844, theme: "dark" as const },
];

let api: Api;
let inv: { draft: string; confirmed: string; partPaid: string; paid: string; cancelled: string; profitRich: string; movable: string };
let ids: { received: string; receivedAllocated: string; reversed: string; supplierPaid: string; busiestShop: string; supplier: string; alpha: string };

test.beforeAll(async () => {
  api = await apiAs("OWNER");
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const posted = await allPayments(api, "status=POSTED");
  const shops = (await api.get<{ id: string }[]>("/customers?limit=100")).slice(0, 30);
  let best = { id: shops[0]!.id, rows: -1 };
  for (const s of shops) {
    const st = await api.get<{ rows: unknown[] }>(`/customers/${s.id}/statement`);
    if (st.rows.length > best.rows) best = { id: s.id, rows: st.rows.length };
  }
  const invoices = await allInvoices(api);
  const firstOf = (status: string, ok: (i: (typeof invoices)[number]) => boolean = () => true) => invoices.find((i) => i.status === status && ok(i))!.id;
  inv = {
    draft: firstOf("DRAFT", (i) => i.itemCount >= 2),
    confirmed: firstOf("CONFIRMED", (i) => i.itemCount >= 2),
    partPaid: firstOf("PARTIALLY_PAID", (i) => i.itemCount >= 2),
    paid: firstOf("PAID", (i) => i.itemCount >= 2 && i.paidP > 0),
    cancelled: firstOf("CANCELLED", (i) => i.number !== null),
    profitRich: firstOf("CONFIRMED", (i) => i.itemCount >= 3),
    movable: firstOf("CONFIRMED", (i) => i.itemCount >= 1 && i.paidP === 0),
  };
  void invoiceDetailOf;
  ids = {
    received: posted.find((p) => p.kind === "received" && p.appliedTo.length === 0)!.id,
    receivedAllocated: posted.find((p) => p.kind === "received" && p.appliedTo.length >= 2)!.id,
    reversed: (await allPayments(api, "status=REVERSED"))[0]!.id,
    supplierPaid: posted.find((p) => p.kind === "paidToSuppliers")!.id,
    busiestShop: best.id,
    supplier: (await findParty(api, "suppliers", SCENARIO.supplier.name)).id,
    alpha: (await findParty(api, "customers", SCENARIO.alpha.name)).id,
  };
});

interface Screen {
  name: string;
  role?: Role;
  url: () => string;
  prepare?: (page: Page) => Promise<void>;
  /** A dialog on the screen: it must fit inside the viewport. */
  dialog?: boolean;
}

const pickParty = async (page: Page, label: string, name: string) => {
  const dlg = page.getByRole("dialog");
  const combo = dlg.getByRole("combobox", { name: label });
  await combo.click();
  await combo.fill(name);
  await dlg.getByRole("option", { name: new RegExp(name) }).click();
};

const SCREENS: Screen[] = [
  { name: "payments-list", url: () => "/payments", prepare: (p) => expect(p.getByTestId("payment-row").first()).toBeVisible() },
  { name: "payments-filtered", url: () => "/payments?tab=received&period=last90&method=Cash", prepare: (p) => expect(p.getByTestId("count-line")).toContainText(" of ") },
  { name: "payments-empty", url: () => "/payments?q=zzzzqqqq", prepare: (p) => expect(p.getByText("No payments match")).toBeVisible() },
  { name: "payments-date-read-as", url: () => "/payments?q=12%2F09%2F2026+karim&period=last30", prepare: (p) => expect(p.getByTestId("search-read-as")).toBeVisible() },
  {
    name: "receive-panel-auto",
    url: () => "/payments?panel=receive",
    dialog: true,
    prepare: async (p) => {
      await pickParty(p, "Shop", SCENARIO.alpha.name);
      await p.getByRole("dialog").getByLabel("Amount received").fill("25,000");
      await expect(p.getByTestId("alloc-preview").first()).toBeVisible();
    },
  },
  {
    name: "receive-panel-manual",
    url: () => "/payments?panel=receive",
    dialog: true,
    prepare: async (p) => {
      await pickParty(p, "Shop", SCENARIO.alpha.name);
      await p.getByRole("dialog").getByLabel("Amount received").fill("2,000");
      await p.getByRole("dialog").getByLabel("Choose amounts").check({ force: true });
      await p.getByRole("dialog").getByLabel(/Amount to apply to INV-/).first().fill("99,999");
    },
  },
  { name: "receive-panel-empty", url: () => "/payments?panel=receive", dialog: true },
  {
    name: "pay-shop-panel",
    url: () => "/payments?panel=refund",
    dialog: true,
    prepare: async (p) => {
      await pickParty(p, "Shop", SCENARIO.gamma.name);
      await p.getByRole("dialog").getByLabel("Amount paid").fill("1,000");
      await expect(p.getByTestId("refund-confirmation")).toBeVisible();
    },
  },
  { name: "detail-posted", url: () => `/payments/${ids.receivedAllocated}`, prepare: (p) => expect(p.getByTestId("voucher-number")).toBeVisible() },
  { name: "detail-reversed", url: () => `/payments/${ids.reversed}`, prepare: (p) => expect(p.getByTestId("reversed-banner")).toBeVisible() },
  {
    name: "reverse-dialog",
    url: () => `/payments/${ids.supplierPaid}`,
    dialog: true,
    prepare: async (p) => {
      await p.getByRole("button", { name: "Reverse voucher" }).click();
      await expect(p.getByRole("dialog")).toBeVisible();
    },
  },
  { name: "receipt-with-allocations", url: () => `/payments/${ids.receivedAllocated}/receipt`, prepare: (p) => expect(p.getByTestId("receipt-allocations")).toBeVisible() },
  { name: "receipt-on-account", url: () => `/payments/${ids.received}/receipt`, prepare: (p) => expect(p.getByTestId("receipt-on-account")).toBeVisible() },
  { name: "voucher-supplier", url: () => `/payments/${ids.supplierPaid}/receipt`, prepare: (p) => expect(p.getByTestId("receipt-title")).toHaveText("PAYMENT VOUCHER") },
  { name: "receipt-reversed", url: () => `/payments/${ids.reversed}/receipt`, prepare: (p) => expect(p.getByTestId("reversed-mark")).toBeVisible() },
  { name: "statement-empty", url: () => "/statements", prepare: (p) => expect(p.getByText("Choose a shop to see its statement")).toBeVisible() },
  { name: "statement-shop", url: () => `/statements?type=customer&partyId=${ids.busiestShop}`, prepare: (p) => expect(p.getByTestId("statement-closing")).toBeVisible() },
  { name: "statement-supplier", url: () => `/statements?type=supplier&partyId=${ids.supplier}`, prepare: (p) => expect(p.getByTestId("statement-closing")).toBeVisible() },
  { name: "invoices-list", url: () => "/invoices", prepare: (p) => expect(p.getByTestId("invoice-row").first()).toBeVisible() },
  { name: "invoices-filtered", url: () => "/invoices?status=PARTIALLY_PAID&period=last90&sort=due", prepare: (p) => expect(p.getByTestId("count-line")).toContainText(" of ") },
  { name: "invoices-empty", url: () => "/invoices?q=zzzzqqqq", prepare: (p) => expect(p.getByText("No invoices match")).toBeVisible() },
  { name: "invoices-date-read-as", url: () => "/invoices?q=12%2F09%2F2026+karim", prepare: (p) => expect(p.getByTestId("search-read-as")).toBeVisible() },
  { name: "invoices-product-hits", url: () => "/invoices?q=sella&scope=product", prepare: (p) => expect(p.getByTestId("row-hits").first()).toBeVisible() },
  { name: "invoice-view-confirmed", url: () => `/invoices/${inv.confirmed}`, prepare: (p) => expect(p.getByTestId("invoice-number")).toBeVisible() },
  { name: "invoice-view-paid", url: () => `/invoices/${inv.paid}`, prepare: (p) => expect(p.getByTestId("receipt-row").first()).toBeVisible() },
  { name: "invoice-view-part-paid", url: () => `/invoices/${inv.partPaid}`, prepare: (p) => expect(p.getByTestId("reason-cancel")).toBeVisible() },
  { name: "invoice-view-draft", url: () => `/invoices/${inv.draft}`, prepare: (p) => expect(p.getByTestId("draft-banner")).toBeVisible() },
  { name: "invoice-view-cancelled", url: () => `/invoices/${inv.cancelled}`, prepare: (p) => expect(p.getByTestId("cancelled-banner")).toBeVisible() },
  { name: "invoice-view-profit", url: () => `/invoices/${inv.profitRich}`, prepare: (p) => expect(p.getByTestId("profit-block")).toBeVisible() },
  { name: "invoice-view-sales", role: "SALES", url: () => `/invoices/${inv.confirmed}`, prepare: (p) => expect(p.getByTestId("invoice-number")).toBeVisible() },
  {
    name: "invoice-cancel-dialog",
    url: () => `/invoices/${inv.movable}`,
    dialog: true,
    prepare: async (p) => {
      await p.getByTestId("action-cancel").click();
      await expect(p.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "invoice-change-shop-dialog",
    url: () => `/invoices/${inv.movable}`,
    dialog: true,
    prepare: async (p) => {
      await p.getByTestId("action-change-shop").click();
      const dlg = p.getByRole("dialog");
      await expect(dlg).toBeVisible();
      const combo = dlg.getByRole("combobox", { name: "Correct shop" });
      await combo.click();
      await combo.fill(SCENARIO.hotel.name);
      await dlg.getByRole("option", { name: new RegExp(SCENARIO.hotel.name) }).click();
      await expect(dlg.getByTestId("cs-new-after")).toBeVisible();
    },
  },
  { name: "invoice-print-classic", url: () => `/invoices/${inv.paid}/print`, prepare: (p) => expect(p.getByTestId("invoice-paper")).toHaveAttribute("data-template", "classic") },
  { name: "invoice-print-standard", url: () => `/invoices/${inv.paid}/print?template=standard`, prepare: (p) => expect(p.getByTestId("invoice-paper")).toHaveAttribute("data-template", "standard") },
  { name: "invoice-print-draft", url: () => `/invoices/${inv.draft}/print`, prepare: (p) => expect(p.getByTestId("invoice-ribbon")).toBeVisible() },
  { name: "invoice-print-cancelled", url: () => `/invoices/${inv.cancelled}/print?template=standard`, prepare: (p) => expect(p.getByTestId("invoice-ribbon")).toBeVisible() },
  // ── S10: the invoice builder (nothing is saved here: the screens are only looked at) ──
  { name: "builder-empty", url: () => "/invoices/new", prepare: (p) => expect(p.getByTestId("no-lines")).toBeVisible() },
  {
    name: "builder-filled",
    url: () => "/invoices/new",
    prepare: async (p) => {
      await chooseShop(p, SCENARIO.delta.name);
      const a = await addProduct(p, "Builder Priced");
      await fillLine(p, a, "qty", "12");
      await fillLine(p, a, "discount", "250");
      const b = await addProduct(p, "Builder BelowCost"); // below its cost: a red hint for the owner
      await fillLine(p, b, "qty", "7.5");
      const c = await addProduct(p, "Builder Tight"); // 20 asked, 10 there: "short by" on the line and in the header
      await fillLine(p, c, "qty", "20");
      await p.getByTestId("field-freight").fill("350.75");
      await p.getByTestId("field-paidAmount").fill("5,000");
      await expect(p.getByTestId("short-count")).toBeVisible();
    },
  },
  {
    name: "builder-error",
    url: () => "/invoices/new",
    prepare: async (p) => {
      await chooseShop(p, SCENARIO.delta.name);
      const a = await addProduct(p, "Builder Priced");
      await fillLine(p, a, "qty", "2.5555");
      await p.getByTestId("save-post").click();
      await expect(p.getByTestId("save-errors")).toBeVisible();
    },
  },
  {
    name: "builder-filled-sales",
    role: "SALES",
    url: () => "/invoices/new",
    prepare: async (p) => {
      await chooseShop(p, SCENARIO.delta.name);
      await fillLine(p, await addProduct(p, "Builder BelowCost"), "qty", "4");
      await expect(p.getByTestId("line-hint")).toHaveCount(0);
    },
  },
  { name: "builder-edit-posted-question", url: () => `/invoices/${inv.movable}/edit`, dialog: true, prepare: (p) => expect(p.getByRole("dialog", { name: "Edit a confirmed invoice?" })).toBeVisible() },
  {
    name: "builder-edit-posted",
    url: () => `/invoices/${inv.partPaid}/edit`,
    prepare: async (p) => {
      await p.getByTestId("gate-continue").click();
      await expect(p.getByTestId("shop-locked")).toBeVisible();
      await expect(p.getByTestId("line-row").first()).toBeVisible();
    },
  },
  { name: "builder-edit-draft", url: () => `/invoices/${inv.draft}/edit`, prepare: (p) => expect(p.getByTestId("discard")).toHaveText("Discard draft") },
  {
    name: "builder-unsaved-question",
    url: () => "/invoices/new",
    dialog: true,
    prepare: async (p) => {
      await p.getByTestId("field-notes").fill("something typed");
      await p.getByRole("link", { name: "← All invoices" }).click();
      await expect(p.getByRole("dialog", { name: "Leave without saving?" })).toBeVisible();
    },
  },
  {
    name: "invoice-post-dialog",
    url: () => `/invoices/${inv.draft}`,
    dialog: true,
    prepare: async (p) => {
      await p.getByTestId("action-post").click();
      await expect(p.getByRole("dialog", { name: "Post this invoice?" })).toBeVisible();
    },
  },
  { name: "builder-not-available", role: "ACCOUNTANT", url: () => "/invoices/new", prepare: (p) => expect(p.getByTestId("not-available")).toBeVisible() },
  { name: "invoices-not-available", role: "INVENTORY", url: () => "/invoices", prepare: (p) => expect(p.getByTestId("not-available")).toBeVisible() },
  { name: "not-available", role: "INVENTORY", url: () => "/payments", prepare: (p) => expect(p.getByTestId("not-available")).toBeVisible() },
  { name: "dashboard", url: () => "/", prepare: (p) => expect(p.getByRole("heading", { level: 1 })).toBeVisible() },
];

for (const screen of SCREENS) {
  test(`screen: ${screen.name} — desktop, phone, dark: fits, no console errors`, async ({ open }) => {
    for (const v of VARIANTS) {
      const { page } = await open(screen.role ?? "OWNER", { width: v.width, height: v.height, theme: v.theme });
      await page.goto(screen.url());
      await screen.prepare?.(page);
      await page.waitForTimeout(250); // let toasts / focus settle
      await expectNoHorizontalScroll(page);
      if (screen.dialog) {
        const box = await page.getByRole("dialog").boundingBox();
        expect(box, `${screen.name} ${v.key}: dialog box`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(v.width);
      }
      // wide content must scroll INSIDE its own box, never widen the page
      const widest = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll("main *")).map((el) => el.getBoundingClientRect().right)));
      if (v.key === "phone" || v.key === "phone-dark") {
        const clipped = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll("main *"))) {
            const r = el.getBoundingClientRect();
            if (r.right <= window.innerWidth + 1) continue;
            // allowed only when some ancestor scrolls horizontally
            let a: Element | null = el.parentElement;
            let scrolls = false;
            while (a && a !== document.body) {
              const ox = getComputedStyle(a).overflowX;
              if (ox === "auto" || ox === "scroll") scrolls = true;
              a = a.parentElement;
            }
            if (!scrolls) out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").slice(0, 40)}`);
          }
          return out.slice(0, 5);
        });
        expect(clipped, `${screen.name}: elements sticking out of the phone screen with no scroll box`).toEqual([]);
      }
      void widest;
      await page.screenshot({ path: shot(`${screen.name}--${v.key}`), fullPage: true });
    }
  });
}

base("screen: sign-in — desktop, phone, dark", async ({ browser }) => {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  void readState;
  for (const v of VARIANTS) {
    const context = await browser.newContext({ viewport: { width: v.width, height: v.height } });
    await context.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch { /* ignore */ } }, v.theme);
    const page = await context.newPage();
    const errors: string[] = [];
    // the app asks /auth/me on every load; its 401 (no session yet) is the browser logging a normal answer, not an app error
    page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && errors.push(m.text()));
    await page.goto("/sign-in");
    await base.expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot(`sign-in--${v.key}`), fullPage: true });
    base.expect(errors).toEqual([]);
    await context.close();
  }
});
