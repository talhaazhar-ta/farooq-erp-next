import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { businessDateOf, exportPurchasesQuerySchema, listPurchasesQuerySchema, PURCHASE_MESSAGES, purchaseRatesQuerySchema, savePurchaseSchema, type Permission } from "@farooq/shared";
import type { Db } from "@farooq/db";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { RequireAnyPermission, RequirePermission } from "../auth/permission.decorator.js";
import type { AuthenticatedUser } from "../auth/session.guard.js";
import { DB } from "../db/db.module.js";
import { CLOCK, type Clock } from "../payments/clock.js";
import { NotFoundError, parseOrRefuse } from "../payments/errors.js";
import { idOr404 } from "../payments/payments.controller.js";
import type { Actor } from "../payments/receipt-core.js";
import { exportPurchasesCsv } from "./purchases.csv.js";
import { listPurchases } from "./purchases.list.js";
import { loadPurchasePrint } from "./purchases.print.js";
import { lastPurchaseRates, loadPurchaseDetail } from "./purchases.queries.js";
import { PurchasesService } from "./purchases.service.js";

/**
 * Who may read purchases (list, CSV, print, detail) and the builder's last-rate hint. INVENTORY (the warehouse role) and SALES hold none of
 * these. S13 checked the legacy: the old ERP never hid the Purchases page from any role (19-collection-rbac.js guards only the collection and
 * profit screens, 34-accounts.js only payroll / milling / statements) — kept closed anyway because purchases carry supplier money (planner
 * decision 2, docs/sessions/S13.md); an owner-visible difference listed in STATUS.
 */
export const PURCHASE_READ_PERMISSIONS: Permission[] = ["PURCHASE_CREATE", "TRANSACTION_CORRECT", "FINANCIAL_REPORT_VIEW"];

const actorOf = (u: AuthenticatedUser): Actor => ({ id: u.id, name: u.name, role: u.role });

@Controller("purchases")
export class PurchasesController {
  constructor(
    @Inject(PurchasesService) private readonly service: PurchasesService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The purchase list and its search (S13): words, a typed date, godown / category / payment status / dates, sorts, the four cards. */
  @RequireAnyPermission(...PURCHASE_READ_PERMISSIONS)
  @Get()
  list(@Query() query: unknown) {
    return listPurchases(this.db, parseOrRefuse(listPurchasesQuerySchema, query));
  }

  /** Every match of the current filters as a CSV. Declared before `:id`. */
  @RequireAnyPermission(...PURCHASE_READ_PERMISSIONS)
  @Get("export.csv")
  async exportCsv(@Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { csv } = await exportPurchasesCsv(this.db, parseOrRefuse(exportPurchasesQuerySchema, query));
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="farooq-co-purchases-${businessDateOf(this.clock.now())}.csv"`);
    reply.header("Cache-Control", "no-store");
    return csv;
  }

  /** The printed purchase model (legacy `DocModel.purchase`, with ordered and received bags apart). */
  @RequireAnyPermission(...PURCHASE_READ_PERMISSIONS)
  @Get(":id/print")
  async print(@Param("id") id: string) {
    const m = await loadPurchasePrint(this.db, idOr404(id, PURCHASE_MESSAGES.notFound));
    if (!m) throw new NotFoundError(PURCHASE_MESSAGES.notFound);
    return m;
  }

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
