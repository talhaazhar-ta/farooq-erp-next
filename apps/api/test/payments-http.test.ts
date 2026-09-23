import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, paymentDetailSchema, paymentListResponseSchema, type Role } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";

/**
 * The HTTP surface: who may call what (per operation, per role), authentication and CSRF, request validation,
 * and the read endpoints S4 will use. Guards decide permissions — never the service.
 */
let h: Harness;
let sessions: Record<Role, Session>;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  sessions = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await h.session(r)]))) as Record<Role, Session>;
  owner = sessions.OWNER;
});
afterAll(async () => {
  await h.close();
});

/** What each role may do, worked out from the S3 plan (NOT read back from ROLE_PERMISSIONS). */
const ALLOWED = {
  receive: ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"], // PAYMENT_CREATE
  pay: ["OWNER", "MANAGER", "ACCOUNTANT"], // PAYMENT_PAYOUT — not SALES
  refund: ["OWNER", "MANAGER", "ACCOUNTANT"], // PAYMENT_PAYOUT — not SALES
  reverse: ["OWNER", "MANAGER", "ACCOUNTANT"], // TRANSACTION_CORRECT
  editAmount: ["OWNER", "MANAGER", "ACCOUNTANT"], // TRANSACTION_CORRECT
  read: ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"], // PAYMENT_CREATE | COLLECTION_VIEW | FINANCIAL_REPORT_VIEW — not INVENTORY
} as const satisfies Record<string, readonly Role[]>;

describe("permissions — every operation, every role", () => {
  it.each(ROLES)("%s", async (role) => {
    const s = sessions[role];
    const can = (op: keyof typeof ALLOWED) => (ALLOWED[op] as readonly Role[]).includes(role);
    const expectStatus = (status: number, allowed: boolean, okStatus: number, label: string) => {
      expect(status, `${role} ${label}`).toBe(allowed ? okStatus : 403);
    };

    const c = await h.seed.customer();
    const sup = await h.seed.supplier();

    const rec = await h.request(s, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 1_000 } });
    expectStatus(rec.status, can("receive"), 201, "receive");
    const pay = await h.request(s, "POST", "/payments/pay", { body: { supplierId: sup.id, amountP: 1_000 } });
    expectStatus(pay.status, can("pay"), 201, "pay");
    const ref = await h.request(s, "POST", "/payments/refund", { body: { customerId: c.id, amountP: 1_000 } });
    expectStatus(ref.status, can("refund"), 201, "refund");

    // reverse / edit act on a voucher the OWNER recorded, so a 403 is about the caller, not the target
    const target = (await h.request(owner, "POST", "/payments/refund", { body: { customerId: c.id, amountP: 2_000 } })).body.id;
    const edit = await h.request(s, "POST", `/payments/${target}/edit-amount`, { body: { amountP: 3_000 } });
    expectStatus(edit.status, can("editAmount"), 200, "edit-amount");
    const rev = await h.request(s, "POST", `/payments/${target}/reverse`, { body: { reason: "test" } });
    expectStatus(rev.status, can("reverse"), 200, "reverse");

    for (const url of ["/payments", `/payments/${target}`, `/customers/${c.id}/balance`, `/suppliers/${sup.id}/balance`, `/customers/${c.id}/outstanding-invoices`, `/suppliers/${sup.id}/outstanding-purchases`]) {
      const res = await h.request(s, "GET", url);
      expectStatus(res.status, can("read"), 200, `GET ${url.replace(/[0-9a-f-]{36}/g, ":id")}`);
    }
  });

  it("a refused call has no side effect (SALES cannot pay out: nothing is written)", async () => {
    const sup = await h.seed.supplier();
    const res = await h.request(sessions.SALES, "POST", "/payments/pay", { body: { supplierId: sup.id, amountP: 5_000 } });
    expect(res.status).toBe(403);
    const [n] = await h.admin`SELECT count(*)::int AS n FROM payments WHERE party_id = ${sup.id}`;
    expect(n!.n).toBe(0);
  });

  it("the picker lookups need MASTER_DATA_VIEW (every signed-in role holds it, the warehouse role included)", async () => {
    for (const role of ROLES) {
      expect((await h.request(sessions[role], "GET", "/customers")).status, role).toBe(200);
      expect((await h.request(sessions[role], "GET", "/suppliers")).status, role).toBe(200);
    }
  });
});

describe("authentication and CSRF", () => {
  it("no session cookie → 401 on every route", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const calls: ["GET" | "POST", string][] = [
      ["GET", "/payments"], ["GET", `/payments/${id}`], ["POST", "/payments/receive"], ["POST", "/payments/pay"], ["POST", "/payments/refund"],
      ["POST", `/payments/${id}/reverse`], ["POST", `/payments/${id}/edit-amount`], ["GET", "/customers"], ["GET", "/suppliers"],
      ["GET", `/customers/${id}/balance`], ["GET", `/suppliers/${id}/balance`], ["GET", `/customers/${id}/outstanding-invoices`], ["GET", `/suppliers/${id}/outstanding-purchases`],
    ];
    for (const [method, url] of calls) {
      const res = await h.request(null, method, url, method === "POST" ? { body: {} } : {});
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it("a POST without the CSRF header, or with a wrong one, is rejected and writes nothing", async () => {
    const c = await h.seed.customer();
    const body = { customerId: c.id, amountP: 1_000 };
    expect((await h.request(owner, "POST", "/payments/receive", { body, csrf: false })).status).toBe(401);
    expect((await h.request(owner, "POST", "/payments/receive", { body, csrf: "wrong-token" })).status).toBe(401);
    const [n] = await h.admin`SELECT count(*)::int AS n FROM payments WHERE party_id = ${c.id}`;
    expect(n!.n).toBe(0);
    const target = (await h.request(owner, "POST", "/payments/refund", { body })).body.id;
    expect((await h.request(owner, "POST", `/payments/${target}/reverse`, { body: { reason: "x" }, csrf: false })).status).toBe(401);
    expect((await h.request(owner, "POST", `/payments/${target}/edit-amount`, { body: { amountP: 5 }, csrf: false })).status).toBe(401);
    expect((await h.request(owner, "GET", `/payments/${target}`)).body.status).toBe("POSTED"); // GET needs no CSRF header
  });
});

describe("request validation (422 { message, errors }, legacy wording)", () => {
  const post = (body: unknown) => h.request(owner, "POST", "/payments/receive", { body });

  it("amount: zero, negative, fractional, a string, missing, absurdly large", async () => {
    const c = await h.seed.customer();
    for (const amountP of [0, -5, 10.5, "1000", null]) {
      const res = await post({ customerId: c.id, amountP });
      expect(res.status, JSON.stringify(amountP)).toBe(422);
      expect(res.body).toEqual({ message: "Enter an amount greater than zero.", errors: ["Enter an amount greater than zero."] });
    }
    expect((await post({ customerId: c.id })).body.message).toBe("Enter an amount greater than zero.");
    expect((await post({ customerId: c.id, amountP: 10_000_000_000_001 })).body.message).toBe("That amount is too large.");
    expect((await post({ customerId: c.id, amountP: 10_000_000_000_000 })).status).toBe(201); // the cap itself is fine
  });

  it("shop: missing, malformed or unknown → 'Choose a shop.'", async () => {
    for (const customerId of [undefined, "abc", "00000000-0000-4000-8000-000000000000"]) {
      const res = await post({ customerId, amountP: 1_000 });
      expect(res.status).toBe(422);
      expect(res.body.message).toBe("Choose a shop.");
    }
  });

  it("supplier: missing, malformed or unknown → 'Choose a supplier.'", async () => {
    for (const supplierId of [undefined, "abc", "00000000-0000-4000-8000-000000000000"]) {
      const res = await h.request(owner, "POST", "/payments/pay", { body: { supplierId, amountP: 1_000 } });
      expect(res.body.message).toBe("Choose a supplier.");
    }
  });

  it("unknown fields are rejected, not ignored — on every write endpoint", async () => {
    const c = await h.seed.customer();
    const sup = await h.seed.supplier();
    const voucher = (await h.request(owner, "POST", "/payments/refund", { body: { customerId: c.id, amountP: 1_000 } })).body.id;
    const calls = [
      ["/payments/receive", { customerId: c.id, amountP: 1_000, status: "REVERSED" }],
      ["/payments/pay", { supplierId: sup.id, amountP: 1_000, receiptNumber: "REC-1" }],
      ["/payments/refund", { customerId: c.id, amountP: 1_000, isRefund: false }],
      [`/payments/${voucher}/reverse`, { reason: "x", force: true }],
      [`/payments/${voucher}/edit-amount`, { amountP: 5, direction: "IN" }],
    ] as const;
    for (const [url, body] of calls) {
      const res = await h.request(owner, "POST", url, { body });
      expect(res.status, url).toBe(422);
      expect(res.body.message, url).toMatch(/Unrecognized key/);
    }
  });

  it("dates: an impossible calendar day, a wrong format and a timestamp are rejected", async () => {
    const c = await h.seed.customer();
    for (const date of ["2026-02-30", "2026-13-01", "01-02-2026", "2026-1-5", "2026-03-05T00:00:00Z", "yesterday"]) {
      const res = await post({ customerId: c.id, amountP: 1_000, date });
      expect(res.status, date).toBe(422);
      expect(res.body.message).toBe("Enter a valid date (YYYY-MM-DD).");
    }
    expect((await post({ customerId: c.id, amountP: 1_000, date: "2028-02-29" })).status).toBe(201); // a real leap day
  });

  it("text fields are trimmed and length-limited; a bad idempotency key is refused", async () => {
    const c = await h.seed.customer();
    expect((await post({ customerId: c.id, amountP: 1, note: "x".repeat(501) })).body.message).toBe("The note is too long (at most 500 characters).");
    expect((await post({ customerId: c.id, amountP: 1, reference: "x".repeat(101) })).body.message).toBe("The reference is too long (at most 100 characters).");
    expect((await post({ customerId: c.id, amountP: 1, method: "x".repeat(41) })).body.message).toBe("The method is too long (at most 40 characters).");
    expect((await post({ customerId: c.id, amountP: 1, idempotencyKey: "short" })).status).toBe(422);
    const ok = await post({ customerId: c.id, amountP: 1, reference: "  spaced  " });
    expect(ok.body.reference).toBe("spaced");
  });

  it("reports every problem at once", async () => {
    const res = await post({ customerId: "abc", amountP: -1, date: "nope" });
    expect(res.body.errors).toEqual(["Choose a shop.", "Enter an amount greater than zero.", "Enter a valid date (YYYY-MM-DD)."]);
  });
});

describe("reads", () => {
  it("POST responses and GET /payments/:id match the shared Zod schema", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 10_000 });
    const made = await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 12_000 } });
    expect(paymentDetailSchema.parse(made.body)).toBeTruthy();
    const got = await h.request(owner, "GET", `/payments/${made.body.id}`);
    expect(paymentDetailSchema.parse(got.body)).toEqual(made.body);
    expect(got.body).toMatchObject({ allocatedP: 10_000, unallocatedP: 2_000, allocations: [{ invoiceId: inv.id, amountP: 10_000 }] });
    expect((await h.request(owner, "GET", "/payments/not-a-uuid")).status).toBe(404);
    expect((await h.request(owner, "GET", "/payments/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  describe("GET /payments — server-side filter and paging", () => {
    let shop: { id: string };
    let sup: { id: string };
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      const tag = `Zq${Date.now().toString(36)}`;
      shop = await h.seed.customer(`${tag} 50%_Shop`);
      sup = await h.seed.supplier(`${tag} Supply Co`);
      const mk = async (key: string, url: string, body: Record<string, unknown>) => {
        const r = await h.request(owner, "POST", url, { body });
        ids[key] = r.body.id;
      };
      await mk("in1", "/payments/receive", { customerId: shop.id, amountP: 1_000, date: "2026-02-01", reference: `${tag}-ref-A` });
      await mk("in2", "/payments/receive", { customerId: shop.id, amountP: 2_000, date: "2026-02-10" });
      await mk("out1", "/payments/pay", { supplierId: sup.id, amountP: 3_000, date: "2026-02-10" });
      await mk("ref1", "/payments/refund", { customerId: shop.id, amountP: 4_000, date: "2026-02-20" });
      await h.request(owner, "POST", `/payments/${ids.in1}/reverse`, { body: { reason: "test" } });
      (globalThis as any).__tag = tag;
    });
    const list = async (qs: string) => {
      const res = await h.request(owner, "GET", `/payments?${qs}`);
      expect(res.status).toBe(200);
      return paymentListResponseSchema.parse(res.body);
    };

    it("orders by payment_date desc, then created_at desc, and reports a total", async () => {
      const r = await list(`partyId=${shop.id}`);
      expect(r.total).toBe(3);
      expect(r.items.map((i) => i.id)).toEqual([ids.ref1, ids.in2, ids.in1]);
      expect(r.limit).toBe(50);
      expect(r.items[0]).toMatchObject({ partyName: expect.stringContaining("Shop"), allocationCount: 0, isRefund: true });
    });

    it("paging: limit / offset, with the total unaffected", async () => {
      const page1 = await list(`partyId=${shop.id}&limit=2`);
      const page2 = await list(`partyId=${shop.id}&limit=2&offset=2`);
      expect(page1.items).toHaveLength(2);
      expect(page2.items.map((i) => i.id)).toEqual([ids.in1]);
      expect([page1.total, page2.total]).toEqual([3, 3]);
    });

    it("filters: direction, partyType, status, from/to (inclusive)", async () => {
      expect((await list(`partyId=${shop.id}&direction=IN`)).items.map((i) => i.id).sort()).toEqual([ids.in1, ids.in2].sort());
      expect((await list(`partyId=${sup.id}&partyType=SUPPLIER`)).items.map((i) => i.id)).toEqual([ids.out1]);
      expect((await list(`partyId=${shop.id}&status=REVERSED`)).items.map((i) => i.id)).toEqual([ids.in1]);
      expect((await list(`partyId=${shop.id}&from=2026-02-10&to=2026-02-10`)).items.map((i) => i.id)).toEqual([ids.in2]);
      expect((await list(`partyId=${shop.id}&from=2026-02-11`)).items.map((i) => i.id)).toEqual([ids.ref1]);
    });

    it("q: receipt number, party name and reference, case-insensitive; wildcards match literally", async () => {
      const tag = (globalThis as any).__tag as string;
      const byReceipt = await h.request(owner, "GET", `/payments/${ids.out1}`);
      const receipt = byReceipt.body.receiptNumber as string;
      expect((await list(`q=${receipt.toLowerCase()}`)).items.map((i) => i.id)).toEqual([ids.out1]);
      expect((await list(`q=${tag.toUpperCase()}%20SUPPLY`)).items.map((i) => i.id)).toEqual([ids.out1]); // supplier name
      expect((await list(`q=${tag}-REF-a`)).items.map((i) => i.id)).toEqual([ids.in1]); // reference
      expect((await list(`q=${encodeURIComponent(`${tag} 50%_`)}`)).total).toBe(3); // the shop's name contains a literal 50%_
      expect((await list(`q=${encodeURIComponent(`${tag} 5_%`)}`)).total).toBe(0); // "_" and "%" are not wildcards
    });

    it("rejects unknown or malformed query parameters (422)", async () => {
      expect((await h.request(owner, "GET", "/payments?bogus=1")).status).toBe(422);
      expect((await h.request(owner, "GET", "/payments?limit=0")).status).toBe(422);
      expect((await h.request(owner, "GET", "/payments?limit=500")).status).toBe(422);
      expect((await h.request(owner, "GET", "/payments?from=2026-02-30")).status).toBe(422);
      expect((await h.request(owner, "GET", "/payments?direction=SIDEWAYS")).status).toBe(422);
    });
  });

  it("GET /customers and /suppliers: search by name / owner / phone, limited, region included", async () => {
    const tag = `Lk${Date.now().toString(36)}`;
    const a = await h.seed.customer(`${tag} Alpha`);
    await h.seed.customer(`${tag} Beta`);
    const rows = (await h.request(owner, "GET", `/customers?q=${tag.toLowerCase()}&limit=1`)).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a.id, name: `${tag} Alpha`, active: true, contact: null, phone: null, region: null });
    expect((await h.request(owner, "GET", `/customers?q=${tag}`)).body).toHaveLength(2);
    const s = await h.seed.supplier(`${tag} Mill`);
    expect((await h.request(owner, "GET", `/suppliers?q=${tag}`)).body.map((r: any) => r.id)).toEqual([s.id]);
    expect((await h.request(owner, "GET", "/customers?limit=101")).status).toBe(422);
  });

  it("GET …/balance comes from the journal (positive = the shop owes us / we owe the supplier); unknown party → 404", async () => {
    const c = await h.seed.customer();
    await h.seed.invoice(c.id, { totalP: 500_000 });
    await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 120_000 } });
    expect((await h.request(owner, "GET", `/customers/${c.id}/balance`)).body).toEqual({ partyId: c.id, balanceP: 380_000 });
    const s = await h.seed.supplier();
    await h.seed.purchase(s.id, { totalP: 900_000 });
    await h.request(owner, "POST", "/payments/pay", { body: { supplierId: s.id, amountP: 250_000 } });
    expect((await h.request(owner, "GET", `/suppliers/${s.id}/balance`)).body).toEqual({ partyId: s.id, balanceP: 650_000 });
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect((await h.request(owner, "GET", `/customers/${ghost}/balance`)).status).toBe(404);
    expect((await h.request(owner, "GET", `/suppliers/${ghost}/outstanding-purchases`)).status).toBe(404);
    expect((await h.request(owner, "GET", "/customers/xyz/outstanding-invoices")).status).toBe(404);
  });

  it("outstanding lists are oldest first and leave out fully paid, DRAFT and CANCELLED documents", async () => {
    const c = await h.seed.customer();
    const newer = await h.seed.invoice(c.id, { number: "INV-O-2", date: "2026-02-09", totalP: 200_000 });
    const older = await h.seed.invoice(c.id, { number: "INV-O-1", date: "2026-02-01", totalP: 100_000 });
    await h.seed.invoice(c.id, { number: null, date: "2026-01-01", totalP: 5, status: "DRAFT" });
    await h.seed.invoice(c.id, { number: "INV-O-X", date: "2026-01-02", totalP: 5, status: "CANCELLED" });
    const paid = await h.seed.invoice(c.id, { number: "INV-O-P", date: "2026-01-03", totalP: 50_000 });
    await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 50_000, allocations: [{ invoiceId: paid.id, amountP: 50_000 }] } });
    const rows = (await h.request(owner, "GET", `/customers/${c.id}/outstanding-invoices`)).body;
    expect(rows.map((r: any) => [r.id, r.outstandingP])).toEqual([[older.id, 100_000], [newer.id, 200_000]]);

    const s = await h.seed.supplier();
    const p2 = await h.seed.purchase(s.id, { number: "PUR-O-2", date: "2026-02-09", totalP: 70_000 });
    const p1 = await h.seed.purchase(s.id, { number: "PUR-O-1", date: "2026-02-01", totalP: 60_000 });
    await h.seed.purchase(s.id, { number: "PUR-O-X", date: "2026-01-01", totalP: 9, status: "CANCELLED" });
    const prs = (await h.request(owner, "GET", `/suppliers/${s.id}/outstanding-purchases`)).body;
    expect(prs.map((r: any) => [r.id, r.outstandingP, r.creditP])).toEqual([[p1.id, 60_000, 0], [p2.id, 70_000, 0]]);
  });
});
