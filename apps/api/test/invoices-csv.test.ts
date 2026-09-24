import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { INVOICE_CSV_HEADER } from "../src/invoices/invoices.csv.js";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { parseCsv } from "./helpers/csv.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * `GET /invoices/export.csv` — the legacy CSV of the invoice list (05-ui-builder.js `LIST.exportCsv`) for every match of the
 * current filters, made safe for Excel and Urdu. The rows are the fixture's invoices worked out by hand (see invoices-list.test.ts).
 */
let h: Harness;
let owner: Session;
beforeAll(async () => {
  await runImport(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "invoices-csv" });
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const exportCsv = (qs = "", as: Session | null = owner) => h.request(as, "GET", `/invoices/export.csv${qs ? `?${qs}` : ""}`);
const table = async (qs = "") => parseCsv(((await exportCsv(qs)).body as string).slice(1));

describe("the file", () => {
  it("has the legacy columns and file name, a byte-order mark, CRLF line ends and every cell quoted", async () => {
    expect([...INVOICE_CSV_HEADER]).toEqual(["Invoice", "Date", "Shop", "Owner", "Region", "Warehouse", "Items", "Bags", "Subtotal", "Discount", "Charges", "Grand total", "Paid", "Balance", "Status"]);
    const res = await exportCsv();
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="farooq-co-invoices-2026-03-05.csv"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.endsWith("\r\n")).toBe(true);
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(9); // header + 8 invoices
    expect(lines[0]).toBe(INVOICE_CSV_HEADER.map((c) => `"${c}"`).join(","));
    for (const l of lines) expect(l.startsWith('"') && l.endsWith('"')).toBe(true);
  });

  it("the file name follows the BUSINESS date (01:30 on the 6th in Karachi is still the 5th in UTC)", async () => {
    h.clock.current = new Date("2026-03-05T20:30:00Z");
    try {
      expect((await exportCsv()).headers["content-disposition"]).toBe('attachment; filename="farooq-co-invoices-2026-03-06.csv"');
    } finally {
      h.clock.current = new Date("2026-03-05T06:00:00Z");
    }
  });

  it("every invoice of the list is a row, in the list's order, with the hand-computed figures in plain rupees", async () => {
    const rows = await table();
    expect(rows[0]).toEqual([...INVOICE_CSV_HEADER]);
    const byNumber = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect(rows.slice(1).map((r) => r[0])).toEqual(["INV-2026-000007", "INV-2026-000006", "INV-2026-000005", "INV-2026-000004", "INV-2026-000003", "DRAFT", "INV-2026-000002", "INV-2026-000001"]);
    // Invoice, Date, Shop, Owner, Region, Warehouse, Items, Bags, Subtotal, Discount, Charges, Grand total, Paid, Balance, Status
    expect(byNumber.get("INV-2026-000007")).toEqual(["INV-2026-000007", "2026-02-15", "", "", "", "Main Godown", "2", "6", "6000", "0", "0", "6000", "0", "5400", "Partly returned"]);
    expect(byNumber.get("INV-2026-000005")).toEqual(["INV-2026-000005", "2026-02-11", "", "", "", "Main Godown", "1", "2.5", "7500", "0", "0", "7500", "2500", "4700", "Partly paid"]); // 750,000 − 250,000 − 30,000
    expect(byNumber.get("INV-2026-000004")).toEqual(["INV-2026-000004", "2026-02-10", "", "", "", "Second Godown", "2", "5", "4000", "1250", "250", "3000", "0", "3000", "Dispatched"]);
    expect(byNumber.get("INV-2026-000003")).toEqual(["INV-2026-000003", "2026-02-04", "", "", "", "Main Godown", "1", "2", "8888.88", "0", "0", "8888.88", "0", "8888.88", "Cancelled"]);
    expect(byNumber.get("DRAFT")).toEqual(["DRAFT", "2026-02-03", "", "", "", "Main Godown", "1", "3", "9999.99", "0", "0", "9999.99", "0", "9999.99", "Draft"]); // a draft's number cell says DRAFT
    expect(byNumber.get("INV-2026-000001")).toEqual(["INV-2026-000001", "2026-02-01", "", "", "", "Main Godown", "1", "10", "10000", "0", "0", "10000", "4000", "6000", "Confirmed"]);
  });

  it("exports EVERY match of the filters, not a page; the filters are the list's", async () => {
    expect((await table("status=PAID")).length).toBe(2);
    expect((await table("status=PAID"))[1]![0]).toBe("INV-2026-000002");
    expect((await table("from=2026-02-10&to=2026-02-12&sort=oldest")).slice(1).map((r) => r[0])).toEqual(["INV-2026-000004", "INV-2026-000005", "INV-2026-000006"]);
    expect((await table("q=000003&scope=payment")).slice(1).map((r) => r[0])).toEqual(["INV-2026-000005"]); // the receipt-number scope
    expect((await table("q=qqzznothing")).length).toBe(1); // header only
    expect((await table("from=2026-12-31&to=2026-01-01")).length).toBe(1); // a problem: header only
  });
});

describe("safety", () => {
  it("neutralises a formula in a printed name or note (a leading apostrophe), doubles quotes, keeps commas and Urdu intact", async () => {
    await h.admin`UPDATE invoices SET shop_name_snapshot = '=cmd|''/c calc''!A0', customer_name_snapshot = 'say "hi", Jr.', region_snapshot = 'الفا بازار — Alpha' WHERE legacy_id = 'inv-5'`;
    const row = (await table("q=000004&scope=number"))[1]!;
    expect(row[2]).toBe("'=cmd|'/c calc'!A0");
    expect(row[3]).toBe('say "hi", Jr.');
    expect(row[4]).toBe("الفا بازار — Alpha");
    const raw = (await exportCsv("q=000004&scope=number")).body as string;
    expect(raw).toContain('"say ""hi"", Jr."');
    await h.admin`UPDATE invoices SET shop_name_snapshot = NULL, customer_name_snapshot = NULL, region_snapshot = NULL WHERE legacy_id = 'inv-5'`;
  });

  it("an unknown query field or a bad value is refused (422), like the list", async () => {
    expect((await exportCsv("limit=5")).status).toBe(422);
    expect((await exportCsv("from=31-12-2026")).status).toBe(422);
    expect((await exportCsv("status=NOPE")).status).toBe(422);
  });
});
