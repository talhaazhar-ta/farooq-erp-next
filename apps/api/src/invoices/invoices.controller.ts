import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  cancelInvoiceSchema,
  changeInvoiceShopSchema,
  duplicateInvoiceSchema,
  INVOICE_MESSAGES,
  productPickQuerySchema,
  saveInvoiceSchema,
  type Permission,
} from "@farooq/shared";
import type { Db } from "@farooq/db";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { RequireAnyPermission, RequirePermission } from "../auth/permission.decorator.js";
import type { AuthenticatedUser } from "../auth/session.guard.js";
import { DB } from "../db/db.module.js";
import { NotFoundError, parseOrRefuse } from "../payments/errors.js";
import { idOr404 } from "../payments/payments.controller.js";
import type { Actor } from "../payments/receipt-core.js";
import { listWarehouses, loadInvoiceDetail, pickProducts } from "./invoices.queries.js";
import { InvoicesService, type InvoiceWriteResult } from "./invoices.service.js";

/** Who may read an invoice. The warehouse role (INVENTORY) holds none of these. */
export const INVOICE_READ_PERMISSIONS: Permission[] = ["SALES_CREATE", "TRANSACTION_CORRECT", "COLLECTION_VIEW", "FINANCIAL_REPORT_VIEW"];

const actorOf = (u: AuthenticatedUser): Actor => ({ id: u.id, name: u.name, role: u.role });

@Controller("invoices")
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly service: InvoicesService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** A create that hit an idempotency key it had already seen answers 200 with the original invoice, not 201. */
  private created(result: InvoiceWriteResult, reply: FastifyReply) {
    if (result.replayed) reply.status(200);
    return result.invoice;
  }

  @RequireAnyPermission(...INVOICE_READ_PERMISSIONS)
  @Get(":id")
  async detail(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await loadInvoiceDetail(this.db, idOr404(id, INVOICE_MESSAGES.notFound), user.role);
    if (!d) throw new NotFoundError(INVOICE_MESSAGES.notFound);
    return d;
  }

  /** A new invoice: `mode: "draft"` saves a draft, `mode: "post"` issues it. */
  @RequirePermission("SALES_CREATE")
  @Post()
  async create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.created(await this.service.save(parseOrRefuse(saveInvoiceSchema, body), actorOf(user), null), reply);
  }

  /** Edit a draft (SALES_CREATE), post a draft (SALES_CREATE) or edit a posted invoice (TRANSACTION_CORRECT) — the service tells which by the invoice's state. */
  @RequireAnyPermission("SALES_CREATE", "TRANSACTION_CORRECT")
  @HttpCode(200)
  @Put(":id")
  async update(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parseOrRefuse(saveInvoiceSchema, body);
    return (await this.service.save(input, actorOf(user), idOr404(id, INVOICE_MESSAGES.notFound))).invoice;
  }

  @RequirePermission("TRANSACTION_CORRECT")
  @HttpCode(200)
  @Post(":id/cancel")
  async cancel(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parseOrRefuse(cancelInvoiceSchema, body);
    return (await this.service.cancel(idOr404(id, INVOICE_MESSAGES.notFound), input, actorOf(user))).invoice;
  }

  @RequirePermission("SALES_CREATE")
  @Post(":id/duplicate")
  async duplicate(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parseOrRefuse(duplicateInvoiceSchema, body ?? {});
    return this.created(await this.service.duplicate(idOr404(id, INVOICE_MESSAGES.notFound), input, actorOf(user)), reply);
  }

  @RequirePermission("TRANSACTION_CORRECT")
  @HttpCode(200)
  @Post(":id/change-shop")
  async changeShop(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parseOrRefuse(changeInvoiceShopSchema, body);
    return (await this.service.changeShop(idOr404(id, INVOICE_MESSAGES.notFound), input, actorOf(user))).invoice;
  }
}

/** The invoice builder's product search and warehouse list. */
@Controller()
export class InvoiceLookupsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("MASTER_DATA_VIEW")
  @Get("products")
  products(@Query() query: unknown, @CurrentUser() user: AuthenticatedUser) {
    return pickProducts(this.db, parseOrRefuse(productPickQuerySchema, query), user.role);
  }

  @RequirePermission("MASTER_DATA_VIEW")
  @Get("warehouses")
  warehouses() {
    return listWarehouses(this.db);
  }
}
