import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  businessDateOf,
  cancelInvoiceSchema,
  changeInvoiceShopSchema,
  duplicateInvoiceSchema,
  exportInvoicesQuerySchema,
  INVOICE_MESSAGES,
  invoicePrintQuerySchema,
  listInvoicesQuerySchema,
  productPickQuerySchema,
  saveInvoiceSchema,
  type Permission,
} from "@farooq/shared";
import type { Db } from "@farooq/db";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { RequireAnyPermission, RequirePermission } from "../auth/permission.decorator.js";
import type { AuthenticatedUser } from "../auth/session.guard.js";
import { DB } from "../db/db.module.js";
import { CLOCK, type Clock } from "../payments/clock.js";
import { NotFoundError, parseOrRefuse } from "../payments/errors.js";
import { idOr404 } from "../payments/payments.controller.js";
import type { Actor } from "../payments/receipt-core.js";
import { exportInvoicesCsv } from "./invoices.csv.js";
import { listInvoices } from "./invoices.list.js";
import { loadInvoicePrint } from "./invoices.print.js";
import { listWarehouses, loadInvoiceDetail, loadInvoiceProfit, pickProducts } from "./invoices.queries.js";
import { InvoicesService, type InvoiceWriteResult } from "./invoices.service.js";

/** Who may read an invoice. The warehouse role (INVENTORY) holds none of these. */
export const INVOICE_READ_PERMISSIONS: Permission[] = ["SALES_CREATE", "TRANSACTION_CORRECT", "COLLECTION_VIEW", "FINANCIAL_REPORT_VIEW"];

const actorOf = (u: AuthenticatedUser): Actor => ({ id: u.id, name: u.name, role: u.role });

@Controller("invoices")
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly service: InvoicesService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** A create that hit an idempotency key it had already seen answers 200 with the original invoice, not 201. */
  private created(result: InvoiceWriteResult, reply: FastifyReply) {
    if (result.replayed) reply.status(200);
    return result.invoice;
  }

  /** The invoice list and its search (legacy module 33): words, dates, scopes, filters, sorts, the four cards, counts by status, "why it matched". */
  @RequireAnyPermission(...INVOICE_READ_PERMISSIONS)
  @Get()
  list(@Query() query: unknown) {
    return listInvoices(this.db, parseOrRefuse(listInvoicesQuerySchema, query));
  }

  /** Every match of the current filters as a CSV (UTF-8 with BOM, RFC 4180, spreadsheet-injection guarded). Declared before `:id`. */
  @RequireAnyPermission(...INVOICE_READ_PERMISSIONS)
  @Get("export.csv")
  async exportCsv(@Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { csv } = await exportInvoicesCsv(this.db, parseOrRefuse(exportInvoicesQuerySchema, query));
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="farooq-co-invoices-${businessDateOf(this.clock.now())}.csv"`);
    reply.header("Cache-Control", "no-store");
    return csv;
  }

  /** The printed invoice model (classic and standard layouts share it). */
  @RequireAnyPermission(...INVOICE_READ_PERMISSIONS)
  @Get(":id/print")
  async print(@Param("id") id: string, @Query() query: unknown) {
    const q = parseOrRefuse(invoicePrintQuerySchema, query);
    const m = await loadInvoicePrint(this.db, idOr404(id, INVOICE_MESSAGES.notFound), q.template);
    if (!m) throw new NotFoundError(INVOICE_MESSAGES.notFound);
    return m;
  }

  /** Profit on one invoice — PROFIT_VIEW only (everyone else: 403; the same figures are in the detail for those who may see them). */
  @RequirePermission("PROFIT_VIEW")
  @Get(":id/profit")
  async profit(@Param("id") id: string) {
    const p = await loadInvoiceProfit(this.db, idOr404(id, INVOICE_MESSAGES.notFound));
    if (!p) throw new NotFoundError(INVOICE_MESSAGES.notFound);
    return p;
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

  /** Discarding a DRAFT needs SALES_CREATE or TRANSACTION_CORRECT; cancelling a posted invoice TRANSACTION_CORRECT — the service tells which by the invoice's state. */
  @RequireAnyPermission("SALES_CREATE", "TRANSACTION_CORRECT")
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
