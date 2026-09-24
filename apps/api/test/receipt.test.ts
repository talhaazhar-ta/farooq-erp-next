import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, uuidV5, type Backup } from "@farooq/import";
import { customers, regions, suppliers, payments } from "@farooq/db";
import { eq } from "drizzle-orm";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { COMPANY_DISPLAY_FIELDS, RECEIPT_LABELS, receiptSchema, type PaymentListResponse, type Receipt } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * The receipt / voucher model (S4 decisions 3 and 4): snapshots, allocations, amount in words, and the party's running
 * balance immediately before / after THIS voucher's row in the statement order — deterministic, so a reprint next month
 * shows the same figures. Expected numbers are worked out by hand (the fixture's are in the header of
 * packages/import/fixtures/build-fixture.ts).
 */
let h: Harness;
let owner: Session;
const backup = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup;
const pay = (l: string) => uuidV5(`payments:${l}`);

beforeAll(async () => {
  await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "receipt" });
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const receipt = async (id: string): Promise<Receipt> => {
  const res = await h.request(owner, "GET", `/payments/${id}/receipt`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return receiptSchema.parse(res.body);
};

describe("the receipt of IMPORTED vouchers (fixture; balances worked out on paper)", () => {
  it("pay-1: a receipt from Al-Noor Traders — snapshots, the two invoices it paid, and the balances around it", async () => {
    const r = await receipt(pay("pay-1"));
    expect(r).toMatchObject({
      kind: "RECEIPT", title: "PAYMENT RECEIPT", number: "REC-2026-000001", status: "Posted", cancelled: false, date: "2026-02-05",
      party: { label: "RECEIVED FROM", type: "CUSTOMER", name: "Al-Noor Traders", owner: "Noor", region: "الفا بازار — Alpha Bazar", phone: null },
      meta: { receiptNumber: "REC-2026-000001", method: "Bank Transfer", reference: null, receivedBy: "Fixture" },
      totalAppliedP: 700_000, amountP: 700_000, amountLabel: "Amount received", amountInWords: "Seven Thousand Rupees Only", reversal: null,
    });
    expect(r.allocations).toEqual([
      { documentType: "INVOICE", documentId: uuidV5("invoices:inv-1"), documentNumber: "INV-2026-000001", documentDate: "2026-02-01", amountP: 400_000 },
      { documentType: "INVOICE", documentId: uuidV5("invoices:inv-2"), documentNumber: "INV-2026-000002", documentDate: "2026-02-01", amountP: 300_000 },
    ]);
    // Al-Noor's statement in order: OPENING 500,000 (first, whatever its date) · inv-1 1,000,000 · inv-2 500,000 · [this receipt −700,000]
    expect(r.previousBalanceP).toBe(2_000_000);
    expect(r.remainingBalanceP).toBe(1_300_000);
    expect(r.company.businessName).toBe("Fixture & Co");
  });

  it("pay-7: a refund voucher (OUT to a shop) — 'PAID TO', the credit note of the same day comes first (entered earlier)", async () => {
    const r = await receipt(pay("pay-7"));
    expect(r).toMatchObject({ kind: "VOUCHER", title: "PAYMENT VOUCHER", amountLabel: "Amount paid", party: { label: "PAID TO", name: "Al-Noor Traders" }, allocations: [], totalAppliedP: 0, notes: "Refund against return CR-2026-000001" });
    // 500,000 + 1,000,000 + 500,000 − 700,000 (pay-1) + 600,000 (inv-8) − 60,000 (return cr-1, entered 06:00) = 1,840,000; the refund adds 60,000 → 1,900,000 (= C1's balance)
    expect(r.previousBalanceP).toBe(1_840_000);
    expect(r.remainingBalanceP).toBe(1_900_000);
  });

  it("pay-4: a supplier voucher — no phone line, the paid-to name is the printed snapshot, and the balance is what we owe", async () => {
    const r = await receipt(pay("pay-4"));
    expect(r).toMatchObject({ kind: "VOUCHER", party: { label: "PAID TO", type: "SUPPLIER", name: "Sunrise Mills Ltd", owner: null, region: null, phone: null }, amountP: 250_000, amountInWords: "Two Thousand Five Hundred Rupees Only" });
    expect(r.allocations).toEqual([{ documentType: "PURCHASE", documentId: uuidV5("purchases:pur-1"), documentNumber: "PUR-2026-000001", documentDate: "2026-02-20", amountP: 250_000 }]);
    // Sunrise: OPENING 300,000 (2026-01-05) · pur-1 900,000 (02-20 09:00) · this payment −250,000 (02-20 10:00) · sr-1 −80,000 (02-21)
    expect(r.previousBalanceP).toBe(1_200_000);
    expect(r.remainingBalanceP).toBe(950_000);
  });

  it("pay-2: a REVERSED voucher is stamped Reversed, cancelled, has no balances, and says why", async () => {
    const r = await receipt(pay("pay-2"));
    expect(r).toMatchObject({ status: "Reversed", cancelled: true, previousBalanceP: null, remainingBalanceP: null, reversal: { reason: "wrong shop", at: "2026-02-07T08:00:00.000Z" }, title: "PAYMENT RECEIPT" });
  });

  it("the legacy wording is carried verbatim (labels + the Urdu ones), for S5 to print", async () => {
    const r = await receipt(pay("pay-1"));
    expect(r.labels).toEqual({ meta: "RECEIPT DETAILS", signatures: ["Received by", "Authorised signature"], thanks: "Thank you for your payment.", terms: "This receipt is valid subject to realisation of the instrument where applicable." });
    expect(RECEIPT_LABELS.receipt).toEqual({ title: "PAYMENT RECEIPT", party: "RECEIVED FROM", amount: "Amount received", amountUr: "وصول رقم" });
    expect(RECEIPT_LABELS.voucher).toEqual({ title: "PAYMENT VOUCHER", party: "PAID TO", amount: "Amount paid", amountUr: "ادا شدہ رقم" });
    expect(RECEIPT_LABELS.remainingBalanceUr).toBe("بقایا رقم");
  });
});

describe("the company block — a whitelist of the settings document, never the whole bag", () => {
  it("exposes exactly the display fields, from the imported `business` document", async () => {
    const r = await receipt(pay("pay-1"));
    expect(Object.keys(r.company).sort()).toEqual([...COMPANY_DISPLAY_FIELDS].sort());
    expect(r.company).toMatchObject({
      businessName: "Fixture & Co", legalName: "Fixture & Co Traders", tagline: "Wholesale Dealer", taglineUr: "ہول سیل ڈیلر", slogan: "Trust in every bag",
      logoText: "F&C", logoDataUrl: null, address: "1 Fixture Road", city: "Testville", phone: "0300-1111111", shopPhone: "0944-000000", whatsapp: null,
      proprietor: "Fixture Owner", currencyLabel: "PKR", bankDetails: "Fixture Bank 0000", preparedByLabel: "Prepared by", receivedByLabel: "Received by",
    });
  });
  it("nothing outside the whitelist leaks: prefixes, SMS settings, switches, templates", async () => {
    const r = await receipt(pay("pay-1"));
    const blob = JSON.stringify(r.company);
    for (const secret of ["invoicePrefix", "receiptPrefix", "smsProvider", "requirePinOnSwitch", "autoBackup", "categories", "invoiceFooter", "taxEnabled"]) expect(blob).not.toContain(secret);
  });
  it("defaults as the legacy DocModel does (logo text F&C, currency PKR); a missing or non-text value is null", async () => {
    await h.admin`DELETE FROM company_profile`;
    let r = await receipt(pay("pay-1"));
    expect(r.company).toMatchObject({ businessName: null, logoText: "F&C", currencyLabel: "PKR", address: null });
    await h.admin`INSERT INTO company_profile (id, doc) VALUES ('biz', ${h.admin.json({ businessName: 42, phone: "  ", city: "Dir", logoText: "", currencyLabel: "Rs" })})`;
    r = await receipt(pay("pay-1"));
    expect(r.company).toMatchObject({ businessName: null, phone: null, city: "Dir", logoText: "F&C", currencyLabel: "Rs" });
  });
});

describe("receipts of vouchers made by the service", () => {
  let counter = 0;
  const method = () => `M${counter++}`;

  it("receive with auto-allocation: rows in order, applied vs on-account, amount in words with paisa, balances", async () => {
    const shop = await h.seed.customer();
    await h.seed.invoice(shop.id, { date: "2026-02-01", number: "INV-R-1", totalP: 100_000 });
    await h.seed.invoice(shop.id, { date: "2026-02-05", number: "INV-R-2", totalP: 50_000 });
    const made = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 123_450, method: method(), reference: "CHQ 9", note: "for Eid", date: "2026-03-01" } })).body;
    const r = await receipt(made.id);
    expect(r.allocations.map((a) => [a.documentNumber, a.documentDate, a.amountP])).toEqual([["INV-R-1", "2026-02-01", 100_000], ["INV-R-2", "2026-02-05", 23_450]]);
    expect(r.totalAppliedP).toBe(123_450);
    expect(r).toMatchObject({ amountP: 123_450, amountInWords: "One Thousand Two Hundred Thirty Four Rupees and Fifty Paisa Only", notes: "for Eid", meta: { reference: "CHQ 9", receivedBy: owner.name } });
    // 150,000 owed before; 150,000 − 123,450 = 26,550 after
    expect([r.previousBalanceP, r.remainingBalanceP]).toEqual([150_000, 26_550]);
  });

  it("money left over stays on account: the applied total is less than the amount", async () => {
    const shop = await h.seed.customer();
    await h.seed.invoice(shop.id, { date: "2026-02-01", totalP: 10_000 });
    const made = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 25_000 } })).body;
    const r = await receipt(made.id);
    expect([r.totalAppliedP, r.amountP]).toEqual([10_000, 25_000]);
    expect([r.previousBalanceP, r.remainingBalanceP]).toEqual([10_000, -15_000]); // an advance: the shop now has a credit
  });

  it("no allocations at all: 'On account' (an empty allocation list) and a supplier voucher's balance is what we owe", async () => {
    const sup = await h.seed.supplier();
    await h.seed.purchase(sup.id, { date: "2026-02-01", totalP: 90_000 });
    const made = (await h.request(owner, "POST", "/payments/pay", { body: { supplierId: sup.id, amountP: 30_000, date: "2026-03-01" } })).body;
    const r = await receipt(made.id);
    expect(r).toMatchObject({ kind: "VOUCHER", allocations: [], totalAppliedP: 0, party: { type: "SUPPLIER", label: "PAID TO" } });
    expect([r.previousBalanceP, r.remainingBalanceP]).toEqual([90_000, 60_000]);
  });

  it("a later voucher on the SAME day does not change an earlier one's figures — and neither does a later month (a reprint is the same)", async () => {
    const shop = await h.seed.customer();
    await h.seed.invoice(shop.id, { date: "2026-03-01", totalP: 100_000 });
    const a = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 30_000, date: "2026-03-02" } })).body;
    const b = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 20_000, date: "2026-03-02" } })).body;
    const firstA = await receipt(a.id);
    expect([firstA.previousBalanceP, firstA.remainingBalanceP]).toEqual([100_000, 70_000]);
    expect([(await receipt(b.id)).previousBalanceP, (await receipt(b.id)).remainingBalanceP]).toEqual([70_000, 50_000]);

    // a third voucher the same day, an invoice next month, and a refund — none of it moves A or B
    await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 5_000, date: "2026-03-02" } });
    await h.seed.invoice(shop.id, { date: "2026-04-15", totalP: 999_000 });
    await h.request(owner, "POST", "/payments/refund", { body: { customerId: shop.id, amountP: 1_000, date: "2026-04-16" } });
    expect(await receipt(a.id)).toEqual(firstA);
    expect([(await receipt(b.id)).previousBalanceP, (await receipt(b.id)).remainingBalanceP]).toEqual([70_000, 50_000]);
  });

  it("a voucher dated BEFORE an existing one but entered later is placed by its date: balances follow the statement, not the clock", async () => {
    const shop = await h.seed.customer();
    await h.seed.invoice(shop.id, { date: "2026-03-01", totalP: 100_000 });
    const late = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 40_000, date: "2026-03-20" } })).body;
    const back = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 10_000, date: "2026-03-10" } })).body;
    expect([(await receipt(back.id)).previousBalanceP, (await receipt(back.id)).remainingBalanceP]).toEqual([100_000, 90_000]);
    expect([(await receipt(late.id)).previousBalanceP, (await receipt(late.id)).remainingBalanceP]).toEqual([90_000, 50_000]);
  });

  it("a voucher that is edited keeps one row: its figures follow the corrected amount", async () => {
    const shop = await h.seed.customer();
    const refund = (await h.request(owner, "POST", "/payments/refund", { body: { customerId: shop.id, amountP: 8_000 } })).body;
    await h.request(owner, "POST", `/payments/${refund.id}/edit-amount`, { body: { amountP: 6_000 } });
    const r = await receipt(refund.id);
    expect([r.amountP, r.previousBalanceP, r.remainingBalanceP]).toEqual([6_000, 0, 6_000]);
    expect(r.amountInWords).toBe("Sixty Rupees Only");
  });

  it("reversing through the service stamps the receipt Reversed and drops its balances", async () => {
    const shop = await h.seed.customer();
    const made = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 5_000 } })).body;
    await h.request(owner, "POST", `/payments/${made.id}/reverse`, { body: { reason: "duplicate entry" } });
    const r = await receipt(made.id);
    expect(r).toMatchObject({ status: "Reversed", cancelled: true, previousBalanceP: null, remainingBalanceP: null, reversal: { reason: "duplicate entry" } });
    expect(r.reversal!.at).toBeTruthy();
  });

  it("unknown or malformed id → 404 'Payment not found.'", async () => {
    expect((await h.request(owner, "GET", "/payments/00000000-0000-4000-8000-000000000000/receipt")).body).toEqual({ message: "Payment not found.", errors: ["Payment not found."] });
    expect((await h.request(owner, "GET", "/payments/nope/receipt")).status).toBe(404);
  });
});

describe("snapshots (decision 4): what was printed is frozen; search finds the voucher by the old AND the new name", () => {
  it("the service snapshots name, owner and region (اردو — English) at creation — and a rename later changes none of them", async () => {
    const [reg] = await h.db.insert(regions).values({ nameEn: "Barawal", nameUr: "براول" }).returning();
    const [shop] = await h.db.insert(customers).values({ shopName: "Old Traders", ownerName: "Ali Khan", phone: "0300-5550001", regionId: reg!.id }).returning();
    const made = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop!.id, amountP: 7_000 } })).body;
    const row = (await h.db.select().from(payments).where(eq(payments.id, made.id)))[0]!;
    expect([row.partyNameSnapshot, row.partyOwnerSnapshot, row.regionSnapshot]).toEqual(["Old Traders", "Ali Khan", "براول — Barawal"]);

    // rename the shop, its owner, its region and its phone
    await h.db.update(customers).set({ shopName: "Brand New Mart", ownerName: "Someone Else", phone: "0345-9998887" }).where(eq(customers.id, shop!.id));
    await h.db.update(regions).set({ nameEn: "Renamed Region", nameUr: "نیا" }).where(eq(regions.id, reg!.id));

    const r = await receipt(made.id);
    expect(r.party).toMatchObject({ name: "Old Traders", owner: "Ali Khan", region: "براول — Barawal", phone: "0345-9998887" }); // the phone is the CURRENT one, as in the legacy
    const detail = (await h.request(owner, "GET", `/payments/${made.id}`)).body;
    expect(detail).toMatchObject({ partyName: "Brand New Mart", partyNameSnapshot: "Old Traders", partyOwnerSnapshot: "Ali Khan", regionSnapshot: "براول — Barawal" });

    const find = async (q: string, scope?: string): Promise<string[]> => {
      const res = await h.request(owner, "GET", `/payments?q=${encodeURIComponent(q)}${scope ? `&scope=${scope}` : ""}`);
      return (res.body as PaymentListResponse).items.map((i) => i.id);
    };
    expect(await find("Old Traders")).toContain(made.id); // the name printed on the voucher
    expect(await find("brand new mart")).toContain(made.id); // the shop's current name
    expect(await find("Old Traders", "party")).toContain(made.id);
    expect(await find("Brand New", "party")).toContain(made.id);
    expect(await find("Someone Else")).toContain(made.id); // current owner
    expect(await find("Ali Khan")).toContain(made.id); // printed owner
    expect(await find("9998887")).toContain(made.id); // current phone (dashes ignored)
    expect(await find("Renamed Region")).toContain(made.id); // current region text
    expect(await find("Barawal")).toContain(made.id); // printed region text
    expect(await find("Old Traders", "reference")).not.toContain(made.id); // a scope other than party does not look at names
  });

  it("a supplier voucher snapshots the name and the contact person (`cp`), and no region", async () => {
    const [sup] = await h.db.insert(suppliers).values({ companyName: "Mill One", legacyDoc: { cp: "Mr Tariq" } }).returning();
    const made = (await h.request(owner, "POST", "/payments/pay", { body: { supplierId: sup!.id, amountP: 1_500 } })).body;
    const row = (await h.db.select().from(payments).where(eq(payments.id, made.id)))[0]!;
    expect([row.partyNameSnapshot, row.partyOwnerSnapshot, row.regionSnapshot]).toEqual(["Mill One", "Mr Tariq", null]);
    await h.db.update(suppliers).set({ companyName: "Mill Renamed" }).where(eq(suppliers.id, sup!.id));
    expect((await receipt(made.id)).party).toMatchObject({ name: "Mill One", owner: "Mr Tariq", region: null });
  });

  it("a refund and an owner-less shop: absent owner / region are null, never empty strings", async () => {
    const shop = await h.seed.customer("Plain Shop");
    const made = (await h.request(owner, "POST", "/payments/refund", { body: { customerId: shop.id, amountP: 900 } })).body;
    const row = (await h.db.select().from(payments).where(eq(payments.id, made.id)))[0]!;
    expect([row.partyNameSnapshot, row.partyOwnerSnapshot, row.regionSnapshot]).toEqual(["Plain Shop", null, null]);
  });

  it("idempotent replay returns the first voucher with its original snapshot (no second snapshot is taken)", async () => {
    const shop = await h.seed.customer("Replay Shop");
    const key = `snap-${Date.now()}-key`;
    const first = await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 100, idempotencyKey: key } });
    await h.db.update(customers).set({ shopName: "Replay Renamed" }).where(eq(customers.id, shop.id));
    const again = await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 100, idempotencyKey: key } });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.partyNameSnapshot).toBe("Replay Shop");
  });

  it("the importer's snapshots come through to the receipt (imported vouchers print what they printed in the old ERP)", async () => {
    // pay-6 is a Cash Counter receipt; its legacy snapshot region is "الفا بازار — Alpha Bazar"
    const r = await receipt(pay("pay-6"));
    expect(r.party).toMatchObject({ name: "Cash Counter", owner: null, region: "الفا بازار — Alpha Bazar" });
  });
});
