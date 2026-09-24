import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { customers, invoices, paymentAllocations, payments } from "@farooq/db";
import { eq } from "drizzle-orm";
import type { PaymentListResponse } from "@farooq/shared";
import { CSV_HEADER, csvCell } from "../src/payments/payments.csv.js";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";

/**
 * `GET /payments/export.csv` — the legacy CSV (38-payment-search.js) for every match, made safe for Excel and Urdu.
 */
let h: Harness;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

/** A small RFC 4180 reader: quoted cells, doubled quotes, commas and line breaks inside quotes, CRLF records. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const exportCsv = async (qs = "", as: Session | null = owner) => h.request(as, "GET", `/payments/export.csv${qs ? `?${qs}` : ""}`);
const COL = Object.fromEntries(CSV_HEADER.map((c, i) => [c, i])) as Record<(typeof CSV_HEADER)[number], number>;

describe("csvCell — quoting and the spreadsheet-injection guard", () => {
  it("always quotes, and doubles a quote inside a cell", () => {
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(1500.5)).toBe('"1500.5"');
  });
  it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tTAB", "\rCR", "=cmd|'/c calc'!A0", "-5 bags"])("a cell starting with a formula character (%j) gets a leading apostrophe", (v) => {
    expect(csvCell(v)).toBe(`"'${v.replace(/"/g, '""')}"`);
  });
  it("only a LEADING formula character is neutralised; one inside the text is left alone", () => {
    expect(csvCell("a=b")).toBe('"a=b"');
    expect(csvCell("Rs 5-6")).toBe('"Rs 5-6"');
    expect(csvCell(" =padded")).toBe('" =padded"'); // spreadsheets do not treat a leading space as a formula
  });
});

describe("the file", () => {
  let shop: { id: string };
  let sup: { id: string };
  const made: Record<string, string> = {};
  const tag = `Csv${Date.now().toString(36)}`;

  beforeAll(async () => {
    const [c] = await h.db.insert(customers).values({ shopName: `${tag} دکان فاروق`, ownerName: "فاروق, Jr." }).returning();
    shop = c!;
    sup = await h.seed.supplier(`${tag} Mill`);
    const inv1 = await h.seed.invoice(shop.id, { date: "2026-02-01", number: `INV-${tag}-1`, totalP: 500_000 });
    const inv2 = await h.seed.invoice(shop.id, { date: "2026-02-02", number: `INV-${tag}-2`, totalP: 500_000 });
    const rec = async (key: string, body: Record<string, unknown>) => {
      const r = await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, ...body } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      made[key] = r.body.id;
    };
    // one receipt paying two invoices and leaving money on account (invoices total 1,000,000; receipt 1,234,550 → 234,550 on account)
    await rec("a", { amountP: 1_234_550, method: "Cheque", reference: "=cmd|'/c calc'!A0", note: 'He said "ok", then\nleft', date: "2026-03-01", allocations: [{ invoiceId: inv1.id, amountP: 500_000 }, { invoiceId: inv2.id, amountP: 500_000 }] });
    await rec("b", { amountP: 100_000, method: "Cash", reference: "-5 bags", date: "2026-03-02" });
    await rec("c", { amountP: 250_075, method: "Cheque", date: "2026-03-03" });
    await h.request(owner, "POST", `/payments/${made.c}/reverse`, { body: { reason: "wrong shop, sorry" } });
    const pay = await h.request(owner, "POST", "/payments/pay", { body: { supplierId: sup.id, amountP: 90_000, method: "JazzCash", date: "2026-03-04" } });
    made.d = pay.body.id;
    const ref = await h.request(owner, "POST", "/payments/refund", { body: { customerId: shop.id, amountP: 5_000, date: "2026-03-05" } });
    made.e = ref.body.id;
  });

  it("is UTF-8 with a byte-order mark, CRLF records, the legacy header, and a Content-Disposition with the BUSINESS date", async () => {
    const res = await exportCsv(`q=${encodeURIComponent(tag)}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="farooq-co-payments-2026-03-05.csv"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.endsWith("\r\n")).toBe(true);
    const rows = parseCsv(text.slice(1));
    expect(rows).toHaveLength(1 + 5); // the header and the five vouchers of this test's shop and supplier (records end CRLF; a LF inside a quoted note is not a record break)
    expect(rows[0]).toEqual(["Number", "Date", "Kind", "Party", "Owner / contact", "Region", "Method", "Amount", "Reference", "Applied to", "On account", "Note", "Status", "Why reversed"]);
    expect(rows.every((r) => r.length === 14)).toBe(true);
  });

  it("the filename date is the Karachi business date, not the UTC date", async () => {
    h.clock.current = new Date("2026-03-05T20:30:00Z"); // 01:30 on the 6th in Karachi
    try {
      expect((await exportCsv(`q=${tag}`)).headers["content-disposition"]).toBe('attachment; filename="farooq-co-payments-2026-03-06.csv"');
    } finally {
      h.clock.current = new Date("2026-03-05T06:00:00Z");
    }
  });

  it("each cell holds the legacy column: kind, printed party, method, amount, applied-to, on account, status, reason", async () => {
    const rows = parseCsv(((await exportCsv(`q=${encodeURIComponent(tag)}&sort=oldest`)).body as string).slice(1));
    const byNo = new Map(rows.slice(1).map((r) => [r[COL.Number]!, r]));
    const detail = async (id: string) => (await h.request(owner, "GET", `/payments/${id}`)).body as { receiptNumber: string };
    const a = byNo.get((await detail(made.a!)).receiptNumber)!;
    expect(a.slice(1)).toEqual([
      "2026-03-01", "Received from shop", `${tag} دکان فاروق`, "فاروق, Jr.", "", "Cheque", "12345.50", "'=cmd|'/c calc'!A0",
      `INV-${tag}-1 INV-${tag}-2`, "2345.50", 'He said "ok", then\nleft', "Posted", "",
    ]);
    const d = byNo.get((await detail(made.d!)).receiptNumber)!;
    expect(d.slice(1, 8)).toEqual(["2026-03-04", "Paid to supplier", `${tag} Mill`, "", "", "JazzCash", "900"]);
    const e = byNo.get((await detail(made.e!)).receiptNumber)!;
    expect([e[COL.Kind], e[COL.Amount], e[COL["On account"]]]).toEqual(["Paid to shop", "50", "50"]);
    const c = byNo.get((await detail(made.c!)).receiptNumber)!;
    expect([c[COL.Amount], c[COL.Status], c[COL["Why reversed"]]]).toEqual(["2500.75", "Reversed", "wrong shop, sorry"]);
  });

  it("neutralises formulas: a reference starting '=' or '-' arrives as text (leading apostrophe), never as a formula", async () => {
    const rows = parseCsv(((await exportCsv(`q=${encodeURIComponent(tag)}`)).body as string).slice(1)).slice(1);
    const refs = rows.map((r) => r[COL.Reference]!).filter(Boolean).sort();
    expect(refs).toEqual(["'-5 bags", "'=cmd|'/c calc'!A0"]);
    for (const r of rows) for (const cell of r) expect(/^[=+\-@\t\r]/.test(cell), cell).toBe(false); // no cell begins with a formula character
  });

  it("exports EVERY match — no paging (300 vouchers come out whole, in the list's order)", async () => {
    const bulk = await h.seed.supplier(`${tag} Bulk`);
    for (let i = 0; i < 230; i++) await h.seed.voucher({ direction: "OUT", partyType: "SUPPLIER", partyId: bulk.id, amountP: 1_000 + i, date: "2026-01-15", receiptNumber: `BULK-${tag}-${String(i).padStart(3, "0")}` });
    const csv = parseCsv(((await exportCsv(`partyId=${bulk.id}&sort=high`)).body as string).slice(1));
    expect(csv).toHaveLength(231); // header + 230 (the list caps a page at 200)
    const list = await h.request(owner, "GET", `/payments?partyId=${bulk.id}&sort=high&limit=200`);
    expect(csv.slice(1, 201).map((r) => r[COL.Number])).toEqual((list.body as PaymentListResponse).items.map((i) => i.receiptNumber));
    // highest first: 1,229 paisa = 12.29 rupees
    expect(csv[1]![COL.Amount]).toBe("12.29");
  });

  it("honours the same filters as the list — the CSV of a query has the rows of the list of that query", async () => {
    for (const qs of [`q=${tag}&direction=received&sort=oldest`, `q=${tag}&method=Cheque`, `q=${tag}&status=REVERSED`, `q=${tag}&from=2026-03-02&to=2026-03-04`, `q=${tag}&minP=100000&maxP=1000000&sort=low`, `q=${tag}%20cheque&scope=notes`]) {
      const csv = parseCsv(((await exportCsv(qs)).body as string).slice(1)).slice(1).map((r) => r[COL.Number]);
      const list = (await h.request(owner, "GET", `/payments?${qs}&limit=200`)).body as PaymentListResponse;
      expect(csv, qs).toEqual(list.items.map((i) => i.receiptNumber));
    }
  });

  it("a search with no match, or an input that can never match, is just the header", async () => {
    for (const qs of ["q=qqzzxxnothing", "from=2026-05-01&to=2026-04-01", "minP=900&maxP=100"]) {
      const rows = parseCsv(((await exportCsv(qs)).body as string).slice(1));
      expect(rows, qs).toHaveLength(1);
    }
  });

  it("takes no paging parameters and no unknown ones (422)", async () => {
    expect((await exportCsv("limit=5")).status).toBe(422);
    expect((await exportCsv("offset=1")).status).toBe(422);
    expect((await exportCsv("bogus=1")).status).toBe(422);
    expect((await exportCsv("from=2026-02-30")).status).toBe(422);
  });

  it("is served ahead of `/payments/:id` (the word 'export.csv' is not an id)", async () => {
    const res = await exportCsv(`partyId=${sup.id}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("string");
  });

  it("the applied-to and on-account columns follow the allocations table (an invoice added later is not guessed)", async () => {
    const row = (await h.db.select().from(payments).where(eq(payments.id, made.a!)))[0]!;
    const allocs = await h.db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, row.id));
    const nums = await Promise.all(allocs.map(async (a) => (await h.db.select().from(invoices).where(eq(invoices.id, a.invoiceId!)))[0]!.invoiceNumber));
    expect(nums.sort()).toEqual([`INV-${tag}-1`, `INV-${tag}-2`]);
  });
});
