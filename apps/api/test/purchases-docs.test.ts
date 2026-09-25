import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { PURCHASE_PRINT_LABELS, purchaseDetailSchema, purchasePrintSchema, type Role } from "@farooq/shared";
import { PURCHASE_CSV_HEADER } from "../src/purchases/purchases.csv.js";
import { createHarness, supplierBalanceSql, type Harness, type Session } from "./helpers/harness.js";
import { parseCsv } from "./helpers/csv.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * S13's other reads of a purchase, on the committed fixture (figures by hand — see purchases-list.test.ts):
 *  - `GET /purchases/export.csv` — every match, the list's filters, BOM / CRLF / quoting / injection guard;
 *  - `GET /purchases/:id/print` — the legacy `DocModel.purchase` with ordered and received bags apart (fix 4);
 *  - the detail's new `actions.changeSupplier`, `supplierCurrentName` and `supplierBalanceP`;
 *  - who may read (INVENTORY and SALES 403 on all of it) and that no cost figure leaks into the list, CSV or print.
 */
let h: Harness;
let owner: Session;
let id: (legacy: string) => string;
beforeAll(async () => {
  await runImport(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "purchases-docs" });
  h = await createHarness();
  owner = await h.session("OWNER");
  const rows = await h.admin`SELECT id, legacy_id FROM purchases`;
  const m = new Map(rows.map((r) => [r.legacy_id as string, r.id as string]));
  id = (l) => m.get(l)!;
});
afterAll(async () => {
  await h.close();
});

const exportCsv = (qs = "", as: Session | null = owner) => h.request(as, "GET", `/purchases/export.csv${qs ? `?${qs}` : ""}`);
const table = async (qs = "") => parseCsv(((await exportCsv(qs)).body as string).slice(1));
const print = async (legacy: string) => {
  const res = await h.request(owner, "GET", `/purchases/${id(legacy)}/print`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return purchasePrintSchema.parse(res.body);
};

describe("CSV", () => {
  it("the columns, file name (business date), BOM, CRLF and every cell quoted", async () => {
    expect([...PURCHASE_CSV_HEADER]).toEqual(["Purchase", "Date", "Supplier ref", "Supplier", "Product", "Bag size", "Warehouse", "Bags ordered", "Bags received", "Rate", "Amount", "Paid", "Balance", "Payment", "Status"]);
    const res = await exportCsv();
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="farooq-co-purchases-2026-03-05.csv"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.endsWith("\r\n")).toBe(true);
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(l.startsWith('"') && l.endsWith('"')).toBe(true);
  });

  it("every purchase is a row in the list's order, with hand-computed figures in plain rupees (ordered and received apart)", async () => {
    const rows = await table();
    expect(rows[0]).toEqual([...PURCHASE_CSV_HEADER]);
    expect(rows.slice(1)).toEqual([
      ["PUR-2026-000004", "2026-02-25", "", "الفلاح ملز", "Fixture p-3", "50 KG", "Main Godown", "100", "60", "10", "1000", "0", "1000", "Unpaid", "Partly received"],
      ["PUR-2026-000003", "2026-02-22", "", "Tariq Brothers", "Fixture p-2", "50 KG", "Main Godown", "6", "6", "500", "3000", "0", "", "Unpaid", "Cancelled"],
      ["PUR-2026-000002", "2026-02-22", "", "Tariq Brothers", "Fixture p-3", "50 KG", "Main Godown", "10", "0", "500", "4000", "0", "4000", "Unpaid", "Draft"],
      ["PUR-2026-000001", "2026-02-20", "", "Sunrise Mills Ltd", "Fixture p-1", "50 KG", "Main Godown", "15", "15", "600", "9000", "2500", "6500", "Partial", "Received"],
    ]);
  });

  it("exports EVERY match of the list's filters (no paging)", async () => {
    expect((await table("paymentStatus=PARTIAL")).slice(1).map((r) => r[0])).toEqual(["PUR-2026-000001"]);
    expect((await table("q=tariq&sort=oldest")).slice(1).map((r) => r[0])).toEqual(["PUR-2026-000002", "PUR-2026-000003"]);
    expect((await table("category=Rice")).slice(1).map((r) => r[0])).toEqual(["PUR-2026-000004", "PUR-2026-000002"]);
    expect((await table("q=qqzznothing")).length).toBe(1);
    expect((await exportCsv("limit=5")).status).toBe(422);
  });

  it("neutralises a formula in the supplier's bill number or name, doubles quotes, keeps Urdu", async () => {
    await h.admin`UPDATE purchases SET supplier_invoice_no = '=HYPERLINK("x")', supplier_name_snapshot = '+1 say "hi", Ltd' WHERE legacy_id = 'pur-2'`;
    try {
      const row = (await table("q=PUR-2026-000002"))[1]!;
      expect(row[2]).toBe(`'=HYPERLINK("x")`);
      expect(row[3]).toBe(`'+1 say "hi", Ltd`);
      expect((await exportCsv("q=PUR-2026-000002")).body as string).toContain('"\'+1 say ""hi"", Ltd"');
    } finally {
      await h.admin`UPDATE purchases SET supplier_invoice_no = '', supplier_name_snapshot = 'Tariq Brothers' WHERE legacy_id = 'pur-2'`;
    }
  });
});

describe("print model (legacy DocModel.purchase)", () => {
  it("title, supplier, meta rows, the strip with ordered AND received bags (fix 4)", async () => {
    const m = await print("pur-4");
    expect(m).toMatchObject({ kind: "PURCHASE", title: "PURCHASE INVOICE", number: "PUR-2026-000004", status: "Unpaid", statusKey: "PARTIALLY_RECEIVED", cancelled: false, date: "2026-02-25" });
    expect(m.party).toMatchObject({ label: "SUPPLIER", name: "الفلاح ملز" });
    expect(m.metaLabel).toBe("PURCHASE DETAILS");
    expect(m.meta).toEqual([
      { label: "Purchase No", value: "PUR-2026-000004", strong: true },
      { label: "Supplier invoice", value: "—", strong: false },
      { label: "Date", value: "25 Feb 2026", strong: false },
      { label: "Warehouse", value: "Main Godown", strong: false },
      { label: "Vehicle", value: "—", strong: false },
      { label: "Driver", value: "", strong: false },
    ]);
    expect(m.strip).toEqual([
      { label: "Payment status", value: "Unpaid" },
      { label: "Bags ordered", value: "100" },
      { label: "Bags received", value: "60" },
      { label: "Lines", value: "1" },
      { label: "Delivery ref", value: "—" },
    ]);
    expect(m.columns.map((c) => c.label)).toEqual(["SR", "Description", "Brand", "Package", "Ordered", "Received", "Rate", "Amount"]);
    expect(m.rows).toEqual([
      expect.objectContaining({ sr: 1, description: "Fixture p-3", brand: "Fixture", pack: "50 KG", ordered: "100", received: "60", orderedQuantity: 100, receivedQuantity: 60, godown: "Second Godown", rate: "10.00", amount: "1,000.00" }),
    ]);
    expect(m.itemsFooter).toEqual({ description: "Total — 1 line", ordered: "100", received: "60", amount: "1,000.00", amountP: 100_000 });
  });

  it("totals: subtotal, the charges that are not zero, grand total, paid by POSTED vouchers, payable; words; the voucher listed", async () => {
    const m = await print("pur-1");
    expect(m.totals.map((t) => [t.label, t.text])).toEqual([
      ["Subtotal", "PKR 8,400"],
      ["Freight", "PKR 400"],
      ["Loading / unloading", "PKR 200"],
      ["Grand total", "PKR 9,000"],
      ["Paid", "PKR 2,500"],
      ["Payable to supplier", "PKR 6,500"],
    ]);
    expect(m).toMatchObject({ totalP: 900_000, paidP: 250_000, balanceP: 650_000, amountInWords: "Nine Thousand Rupees Only", status: "Partly paid" });
    expect(m.payments).toEqual([expect.objectContaining({ receiptNumber: "PV-2026-000002", amountP: 250_000, text: "PKR 2,500" })]);
    expect(m.rows.map((r) => [r.ordered, r.received, r.godown])).toEqual([["12", "12", "Main Godown"], ["3", "3", "Second Godown"]]);
    expect(m.signatures).toEqual(["Received by", "Store keeper", "Authorised signature"]);
    expect(m.footer.thanks).toBe("Goods received in good condition unless noted.");
  });

  it("a discount is drawn as one row (line + overall, as the legacy header keeps it); a cancelled purchase is flagged for the stamp", async () => {
    const d = await print("pur-2");
    expect(d.totals.map((t) => [t.key, t.text])).toEqual([["subtotal", "PKR 5,000"], ["discounts", "− PKR 1,000"], ["grand", "PKR 4,000"], ["paid", "PKR 0"], ["payable", "PKR 4,000"]]);
    expect(d.strip.find((s) => s.label === "Bags received")!.value).toBe("0");
    const c = await print("pur-3");
    expect(c.cancelled).toBe(true);
    expect(c.labels.ribbon).toBe("CANCELLED");
    // not owed: no Paid / Payable rows, and the status says Cancelled (not "Unpaid")
    expect(c.totals.map((t) => t.key)).toEqual(["subtotal", "grand"]);
    expect(c.status).toBe("Cancelled");
    expect(c.strip[0]).toEqual({ label: "Payment status", value: "Cancelled" });
  });

  it("the legacy wording (verbatim constants) and no cost key anywhere in the model", async () => {
    expect(PURCHASE_PRINT_LABELS.signatures).toEqual(["Received by", "Store keeper", "Authorised signature"]);
    const text = JSON.stringify(await print("pur-1"));
    for (const k of ["goodsUnitCost", "chargeShare", "landedUnitCost", "operationalShare", "avgCost", "lastCost", "costs"]) expect(text).not.toContain(k);
  });

  it("404 for an unknown or malformed id", async () => {
    expect((await h.request(owner, "GET", "/purchases/00000000-0000-4000-8000-000000000000/print")).status).toBe(404);
    expect((await h.request(owner, "GET", "/purchases/nope/print")).status).toBe(404);
  });
});

describe("detail: can the supplier be changed, the supplier now", () => {
  const detail = async (legacy: string, as: Session = owner) => purchaseDetailSchema.parse((await h.request(as, "GET", `/purchases/${id(legacy)}`)).body);

  it("a paid purchase: locked, with the legacy sentence naming the voucher; nothing attached: allowed; cancelled: the cancelled sentence", async () => {
    expect((await detail("pur-1")).actions.changeSupplier).toEqual({ allowed: false, reason: "Money has already been paid against this purchase (PV-2026-000002), and it belongs to this supplier — so the supplier cannot be changed here. Reverse that payment voucher first." });
    expect((await detail("pur-2")).actions.changeSupplier).toEqual({ allowed: true, reason: null });
    expect((await detail("pur-3")).actions.changeSupplier).toEqual({ allowed: false, reason: "A cancelled purchase cannot be edited." });
  });

  it("returned bags on a line lock it too; a role that may not edit is told why", async () => {
    const [line] = await h.admin`SELECT id FROM purchase_items WHERE purchase_id = ${id("pur-4")} LIMIT 1`;
    await h.admin`UPDATE purchase_items SET returned_qty_milli = 5000 WHERE id = ${line!.id}`;
    try {
      expect((await detail("pur-4")).actions.changeSupplier.allowed).toBe(false);
    } finally {
      await h.admin`UPDATE purchase_items SET returned_qty_milli = 0 WHERE id = ${line!.id}`;
    }
    expect((await detail("pur-2", await h.session("ACCOUNTANT"))).actions.changeSupplier).toEqual({ allowed: true, reason: null }); // TRANSACTION_CORRECT
  });

  it("the supplier's name now and the supplier's whole balance (from the journal)", async () => {
    const d = await detail("pur-1");
    const [sup] = await h.admin`SELECT id FROM suppliers WHERE legacy_id = 'sup-1'`;
    expect(d.supplierBalanceP).toBe(await supplierBalanceSql(h.admin, sup!.id as string));
    expect(d.supplierCurrentName).toBe("Sunrise Mills Ltd");
  });
});

describe("who may read", () => {
  const urls = () => ["/purchases", "/purchases/export.csv", `/purchases/${id("pur-1")}/print`, `/purchases/${id("pur-1")}`];

  it("OWNER, MANAGER, ACCOUNTANT read all of it; INVENTORY (warehouse) and SALES get 403; no session 401", async () => {
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as Role[]) {
      const s = await h.session(role);
      for (const u of urls()) expect((await h.request(s, "GET", u)).status, `${role} ${u}`).toBe(200);
    }
    for (const role of ["INVENTORY", "SALES"] as Role[]) {
      const s = await h.session(role);
      for (const u of urls()) expect((await h.request(s, "GET", u)).status, `${role} ${u}`).toBe(403);
    }
    for (const u of urls()) expect((await h.request(null, "GET", u)).status, u).toBe(401);
  });

  it("no cost figure in the list or the CSV, for any role", async () => {
    const text = JSON.stringify((await h.request(owner, "GET", "/purchases")).body) + String((await exportCsv()).body);
    for (const k of ["goodsUnitCost", "landedUnitCost", "avgCost", "Cost"]) expect(text).not.toContain(k);
  });
});
