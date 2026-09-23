import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  customers,
  invoices,
  loadAccountIds,
  paymentLines,
  payments,
  postJournalEntry,
  purchases,
  returns,
  sessions,
  suppliers,
  users,
  custLine,
  supLine,
  plainLine,
  type Db,
} from "@farooq/db";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import type { PaymentDetail, Role } from "@farooq/shared";
import { AppModule } from "../../src/app.module.js";
import { CLOCK, type Clock } from "../../src/payments/clock.js";
import { PaymentsService, type Actor } from "../../src/payments/payments.service.js";
import { TEST_APP_URL } from "../setup/db-config.js";

/** A clock the test can move. Default: 11:00 in Karachi on 2026-03-05. */
export class TestClock implements Clock {
  constructor(public current = new Date("2026-03-05T06:00:00Z")) {}
  now(): Date {
    return this.current;
  }
}

export interface Session {
  userId: string;
  name: string;
  role: Role;
  cookie: string;
  csrf: string;
}

export interface Harness {
  app: NestFastifyApplication;
  db: Db;
  /** Superuser connection (raw SQL, for assertions the app role should not need). */
  admin: ReturnType<typeof postgres>;
  clock: TestClock;
  service: PaymentsService;
  session(role: Role): Promise<Session>;
  actor(s: Session): Actor;
  request(as: Session | null, method: "GET" | "POST", url: string, opts?: { body?: unknown; csrf?: boolean | string }): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  seed: Seeder;
  close(): Promise<void>;
}

export async function createHarness(clock = new TestClock()): Promise<Harness> {
  process.env.APP_DATABASE_URL = TEST_APP_URL;
  process.env.NODE_ENV = "test";

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const { db, client } = createDb(TEST_APP_URL);
  const admin = postgres(TEST_ADMIN_URL, { max: 2, onnotice: () => undefined });

  const sessionsCache = new Map<Role, Session>();
  const session = async (role: Role): Promise<Session> => {
    const cached = sessionsCache.get(role);
    if (cached) return cached;
    const name = `Test ${role} ${randomUUID().slice(0, 6)}`;
    const [u] = await db.insert(users).values({ name, username: `t-${randomUUID()}`, passwordHash: "not-a-real-hash", role }).returning();
    const csrf = randomUUID();
    const [s] = await db
      .insert(sessions)
      .values({ userId: u!.id, csrfToken: csrf, expiresAt: new Date(Date.now() + 3_600_000) })
      .returning();
    const made = { userId: u!.id, name, role, cookie: s!.id, csrf };
    sessionsCache.set(role, made);
    return made;
  };

  const request: Harness["request"] = async (as, method, url, opts = {}) => {
    const headers: Record<string, string> = {};
    if (as && opts.csrf !== false) headers["x-csrf-token"] = typeof opts.csrf === "string" ? opts.csrf : as.csrf;
    const res = await app.inject({
      method,
      url,
      headers,
      ...(as ? { cookies: { fc_sid: as.cookie } } : {}),
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
    let body: any = null;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, headers: res.headers as Record<string, unknown> };
  };

  return {
    app,
    db,
    admin,
    clock,
    service: app.get(PaymentsService),
    session,
    actor: (s) => ({ id: s.userId, name: s.name, role: s.role }),
    request,
    seed: new Seeder(db),
    close: async () => {
      await app.close();
      await client.end();
      await admin.end();
    },
  };
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Seeds business rows through the app role. Invoices/purchases/returns are inserted the way the importer would
 * have (a row + its journal entry), so ledger balances are meaningful. Every call makes fresh, uniquely named
 * parties, so tests never collide and nothing needs truncating.
 */
export class Seeder {
  constructor(private readonly db: Db) {}

  async customer(name = `Shop ${uniq()}`) {
    const [c] = await this.db.insert(customers).values({ shopName: name }).returning();
    return c!;
  }

  async supplier(name = `Supplier ${uniq()}`) {
    const [s] = await this.db.insert(suppliers).values({ companyName: name }).returning();
    return s!;
  }

  /** An invoice row, plus its DR RECEIVABLES / CR SALES entry unless DRAFT or CANCELLED (as the importer posts). */
  async invoice(customerId: string, o: { number?: string | null; date?: string; totalP: number; status?: string; createdAt?: string }) {
    const status = o.status ?? "CONFIRMED";
    const [inv] = await this.db
      .insert(invoices)
      .values({
        customerId,
        invoiceNumber: o.number === undefined ? `INV-T-${uniq()}` : o.number,
        date: o.date ?? "2026-02-01",
        totalP: o.totalP,
        status,
        ...(o.createdAt ? { createdAt: new Date(o.createdAt) } : {}),
      })
      .returning();
    if (status !== "DRAFT" && status !== "CANCELLED") {
      await this.db.transaction(async (tx) => {
        const acc = await loadAccountIds(tx);
        await postJournalEntry(tx, acc, {
          date: inv!.date,
          memo: `Sales invoice ${inv!.invoiceNumber ?? ""}`.trim(),
          sourceType: "INVOICE",
          sourceId: inv!.id,
          createdBy: null,
          lines: [custLine(customerId, o.totalP, 0), plainLine("SALES", 0, o.totalP)],
        });
      });
    }
    return inv!;
  }

  async purchase(supplierId: string, o: { number?: string | null; date?: string; totalP: number; status?: string }) {
    const status = o.status ?? "RECEIVED";
    const [pur] = await this.db
      .insert(purchases)
      .values({ supplierId, purchaseNumber: o.number === undefined ? `PUR-T-${uniq()}` : o.number, date: o.date ?? "2026-02-01", totalP: o.totalP, status })
      .returning();
    if (status !== "CANCELLED") {
      await this.db.transaction(async (tx) => {
        const acc = await loadAccountIds(tx);
        await postJournalEntry(tx, acc, {
          date: pur!.date,
          memo: `Purchase ${pur!.purchaseNumber ?? ""}`.trim(),
          sourceType: "PURCHASE",
          sourceId: pur!.id,
          createdBy: null,
          lines: [plainLine("PURCHASES", o.totalP, 0), supLine(supplierId, 0, o.totalP)],
        });
      });
    }
    return pur!;
  }

  /** A customer return linked to an invoice (row only — enough for `Invoices.outstanding`). */
  async customerReturn(customerId: string, invoiceId: string | null, o: { totalP: number; status?: string; number?: string; treatment?: string; refundPaymentId?: string | null }) {
    const [r] = await this.db
      .insert(returns)
      .values({
        kind: "CUSTOMER",
        partyId: customerId,
        invoiceId,
        returnNumber: o.number ?? `CR-T-${uniq()}`,
        date: "2026-02-10",
        totalP: o.totalP,
        status: o.status ?? "POSTED",
        treatment: o.treatment ?? "ADJUST_OUTSTANDING_BALANCE",
        refundPaymentId: o.refundPaymentId ?? null,
      })
      .returning();
    return r!;
  }

  /** A voucher inserted directly (as the importer would), with its journal entry. Returns the row. */
  async voucher(o: {
    direction: "IN" | "OUT";
    partyType: "CUSTOMER" | "SUPPLIER";
    partyId: string;
    amountP: number;
    receiptNumber?: string;
    reference?: string | null;
    note?: string | null;
    status?: "POSTED" | "REVERSED";
    date?: string;
  }) {
    const [p] = await this.db
      .insert(payments)
      .values({
        direction: o.direction,
        partyType: o.partyType,
        partyId: o.partyId,
        isRefund: o.direction === "OUT" && o.partyType === "CUSTOMER",
        amountP: o.amountP,
        method: "Cash",
        reference: o.reference ?? null,
        note: o.note ?? null,
        paymentDate: o.date ?? "2026-02-20",
        status: o.status ?? "POSTED",
        receiptNumber: o.receiptNumber ?? `SEED-${uniq()}`,
      })
      .returning();
    await this.db.transaction(async (tx) => {
      const acc = await loadAccountIds(tx);
      await postJournalEntry(tx, acc, {
        date: p!.paymentDate,
        memo: `Seeded ${p!.receiptNumber}`,
        sourceType: "PAYMENT",
        sourceId: p!.id,
        createdBy: null,
        lines: paymentLines({ direction: o.direction, partyType: o.partyType, partyId: o.partyId, amountP: o.amountP }),
      });
    });
    return p!;
  }
}

/* ── assertions helpers that read the database independently of the service ─── */

/** A shop's balance from the journal, via raw SQL (debit − credit on RECEIVABLES). */
export async function customerBalanceSql(admin: Harness["admin"], customerId: string): Promise<number> {
  const rows = await admin`
    SELECT COALESCE(SUM(l.debit_p - l.credit_p), 0)::text AS b
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.code = 'RECEIVABLES' AND l.party_id = ${customerId}`;
  return Number(rows[0]!.b);
}

/** A supplier's balance from the journal, via raw SQL (credit − debit on PAYABLES). */
export async function supplierBalanceSql(admin: Harness["admin"], supplierId: string): Promise<number> {
  const rows = await admin`
    SELECT COALESCE(SUM(l.credit_p - l.debit_p), 0)::text AS b
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.code = 'PAYABLES' AND l.party_id = ${supplierId}`;
  return Number(rows[0]!.b);
}

export async function invoiceStatus(admin: Harness["admin"], invoiceId: string): Promise<string> {
  const rows = await admin`SELECT status FROM invoices WHERE id = ${invoiceId}`;
  return rows[0]!.status as string;
}

export interface EntryWithLines {
  id: string;
  date: string;
  memo: string;
  created_by: string | null;
  lines: { code: string; party_type: string | null; party_id: string | null; debit: number; credit: number }[];
}

/** Entries (with lines) for a document, straight from SQL. */
export async function entriesFor(admin: Harness["admin"], sourceType: string, sourceId: string): Promise<EntryWithLines[]> {
  const entries = await admin`SELECT id, date::text AS date, memo, created_by FROM journal_entries WHERE source_type = ${sourceType} AND source_id = ${sourceId}`;
  const out: EntryWithLines[] = [];
  for (const e of entries) {
    const lines = await admin`
      SELECT a.code, l.party_type, l.party_id, l.debit_p::int AS debit, l.credit_p::int AS credit
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ${e.id} ORDER BY a.code`;
    out.push({
      id: e.id as string,
      date: e.date as string,
      memo: e.memo as string,
      created_by: e.created_by as string | null,
      lines: lines.map((l) => ({ code: l.code, party_type: l.party_type, party_id: l.party_id, debit: l.debit, credit: l.credit })),
    });
  }
  return out;
}

export const sumAllocations = (p: PaymentDetail): number => p.allocations.reduce((a, x) => a + x.amountP, 0);

export const trialBalance = async (admin: Harness["admin"]) => {
  const [t] = await admin`SELECT COALESCE(SUM(debit_p),0)::text AS d, COALESCE(SUM(credit_p),0)::text AS c FROM journal_lines`;
  return { debit: Number(t!.d), credit: Number(t!.c) };
};

export { sql };
