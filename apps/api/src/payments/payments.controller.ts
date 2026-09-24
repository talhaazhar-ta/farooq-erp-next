import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  businessDateOf,
  editPaymentAmountSchema,
  exportPaymentsQuerySchema,
  listPaymentsQuerySchema,
  payPaymentSchema,
  PAYMENT_MESSAGES,
  receivePaymentSchema,
  refundPaymentSchema,
  reversePaymentSchema,
  type Permission,
} from "@farooq/shared";
import type { Db } from "@farooq/db";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { RequireAnyPermission, RequirePermission } from "../auth/permission.decorator.js";
import type { AuthenticatedUser } from "../auth/session.guard.js";
import { DB } from "../db/db.module.js";
import { CLOCK, type Clock } from "./clock.js";
import { exportPaymentsCsv } from "./payments.csv.js";
import { loadReceipt } from "../statements/statements.queries.js";
import { NotFoundError, parseOrRefuse } from "./errors.js";
import { loadPaymentDetail, listPayments } from "./payments.queries.js";
import { PaymentsService, type Actor, type WriteResult } from "./payments.service.js";
import { z } from "zod";

/** Who may read payments, balances and outstanding lists. The warehouse role (INVENTORY) holds none of these. */
export const PAYMENT_READ_PERMISSIONS: Permission[] = ["PAYMENT_CREATE", "COLLECTION_VIEW", "FINANCIAL_REPORT_VIEW"];

const uuidParam = z.string().uuid();
/** A malformed id can't name a payment: 404, not a database error. */
export const idOr404 = (raw: string, message: string): string => {
  const r = uuidParam.safeParse(raw);
  if (!r.success) throw new NotFoundError(message);
  return r.data;
};

const actorOf = (u: AuthenticatedUser): Actor => ({ id: u.id, name: u.name, role: u.role });

@Controller("payments")
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly service: PaymentsService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** A create that hit an idempotency key it had already seen answers 200 with the original voucher, not 201. */
  private created(result: WriteResult, reply: FastifyReply) {
    if (result.replayed) reply.status(200);
    return result.payment;
  }

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get()
  list(@Query() query: unknown, @CurrentUser() _user: AuthenticatedUser) {
    return listPayments(this.db, parseOrRefuse(listPaymentsQuerySchema, query));
  }

  /** Every match of the current filters as a CSV (UTF-8 with BOM, RFC 4180, spreadsheet-injection guarded). Declared before `:id`. */
  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get("export.csv")
  async exportCsv(@Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { csv } = await exportPaymentsCsv(this.db, parseOrRefuse(exportPaymentsQuerySchema, query));
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="farooq-co-payments-${businessDateOf(this.clock.now())}.csv"`);
    reply.header("Cache-Control", "no-store");
    return csv;
  }

  /** The printed receipt / voucher model: company block, snapshots, allocations, amount in words, balances before / after. */
  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id/receipt")
  async receipt(@Param("id") id: string) {
    const r = await loadReceipt(this.db, idOr404(id, PAYMENT_MESSAGES.notFound));
    if (!r) throw new NotFoundError(PAYMENT_MESSAGES.notFound);
    return r;
  }

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id")
  async detail(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await loadPaymentDetail(this.db, idOr404(id, PAYMENT_MESSAGES.notFound), user.role);
    if (!d) throw new NotFoundError(PAYMENT_MESSAGES.notFound);
    return d;
  }

  /** Money in from a shop. */
  @RequirePermission("PAYMENT_CREATE")
  @Post("receive")
  async receive(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.created(await this.service.receive(parseOrRefuse(receivePaymentSchema, body), actorOf(user)), reply);
  }

  /** Money out to a supplier — a payout, so PAYMENT_PAYOUT (new in S3; SALES does not hold it). */
  @RequirePermission("PAYMENT_PAYOUT")
  @Post("pay")
  async pay(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.created(await this.service.pay(parseOrRefuse(payPaymentSchema, body), actorOf(user)), reply);
  }

  /** Money out to a shop. */
  @RequirePermission("PAYMENT_PAYOUT")
  @Post("refund")
  async refund(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.created(await this.service.refund(parseOrRefuse(refundPaymentSchema, body), actorOf(user)), reply);
  }

  @RequirePermission("TRANSACTION_CORRECT")
  @HttpCode(200)
  @Post(":id/reverse")
  async reverse(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parseOrRefuse(reversePaymentSchema, body);
    return (await this.service.reverse(idOr404(id, PAYMENT_MESSAGES.notFound), input, actorOf(user))).payment;
  }

  @RequirePermission("TRANSACTION_CORRECT")
  @HttpCode(200)
  @Post(":id/edit-amount")
  async editAmount(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parseOrRefuse(editPaymentAmountSchema, body);
    return (await this.service.editAmount(idOr404(id, PAYMENT_MESSAGES.notFound), input, actorOf(user))).payment;
  }
}
