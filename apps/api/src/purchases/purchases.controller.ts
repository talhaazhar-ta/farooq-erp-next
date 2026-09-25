import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { PURCHASE_MESSAGES, purchaseRatesQuerySchema, savePurchaseSchema, type Permission } from "@farooq/shared";
import type { Db } from "@farooq/db";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { RequireAnyPermission, RequirePermission } from "../auth/permission.decorator.js";
import type { AuthenticatedUser } from "../auth/session.guard.js";
import { DB } from "../db/db.module.js";
import { NotFoundError, parseOrRefuse } from "../payments/errors.js";
import { idOr404 } from "../payments/payments.controller.js";
import type { Actor } from "../payments/receipt-core.js";
import { lastPurchaseRates, loadPurchaseDetail } from "./purchases.queries.js";
import { PurchasesService } from "./purchases.service.js";

/**
 * Who may read a purchase and the builder's last-rate hint. INVENTORY (the warehouse role) and SALES hold none of these: S13 confirms the
 * legacy page guard and changes this, saying so, if it differs (planner decision 9, docs/sessions/S12.md).
 */
export const PURCHASE_READ_PERMISSIONS: Permission[] = ["PURCHASE_CREATE", "TRANSACTION_CORRECT", "FINANCIAL_REPORT_VIEW"];

const actorOf = (u: AuthenticatedUser): Actor => ({ id: u.id, name: u.name, role: u.role });

@Controller("purchases")
export class PurchasesController {
  constructor(
    @Inject(PurchasesService) private readonly service: PurchasesService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** The rate of the most recent purchase of each named product (the builder's hint). Declared before `:id`. */
  @RequireAnyPermission(...PURCHASE_READ_PERMISSIONS)
  @Get("last-rates")
  lastRates(@Query() query: unknown) {
    return lastPurchaseRates(this.db, parseOrRefuse(purchaseRatesQuerySchema, query).productIds);
  }

  @RequireAnyPermission(...PURCHASE_READ_PERMISSIONS)
  @Get(":id")
  async detail(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await loadPurchaseDetail(this.db, idOr404(id, PURCHASE_MESSAGES.notFound), user.role);
    if (!d) throw new NotFoundError(PURCHASE_MESSAGES.notFound);
    return d;
  }

  /** Records a purchase (PURCHASE_CREATE). A create that hit an idempotency key it had already seen answers 200 with the original purchase, not 201. */
  @RequirePermission("PURCHASE_CREATE")
  @Post()
  async create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.service.save(parseOrRefuse(savePurchaseSchema, body), actorOf(user), null);
    if (result.replayed) reply.status(200);
    return result.purchase;
  }

  /** Edits a recorded purchase: PURCHASE_CREATE or TRANSACTION_CORRECT (legacy `canEdit`). Paying more with it also needs PAYMENT_PAYOUT (the service says so). */
  @RequireAnyPermission("PURCHASE_CREATE", "TRANSACTION_CORRECT")
  @HttpCode(200)
  @Put(":id")
  async update(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parseOrRefuse(savePurchaseSchema, body);
    return (await this.service.save(input, actorOf(user), idOr404(id, PURCHASE_MESSAGES.notFound))).purchase;
  }
}
