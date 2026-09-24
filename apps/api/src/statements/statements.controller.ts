import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { statementQuerySchema } from "@farooq/shared";
import type { Db } from "@farooq/db";
import { RequireAnyPermission, RequirePermission } from "../auth/permission.decorator.js";
import { DB } from "../db/db.module.js";
import { BusinessRuleError, NotFoundError, parseOrRefuse } from "../payments/errors.js";
import { PAYMENT_READ_PERMISSIONS, idOr404 } from "../payments/payments.controller.js";
import { listRegions, loadCompany, loadStatement } from "./statements.queries.js";
import type { PartyType } from "./ledger.js";

/** Same rules as the payment reads: any of PAYMENT_CREATE / COLLECTION_VIEW / FINANCIAL_REPORT_VIEW (the warehouse role has none). */
async function statementOf(db: Db, type: PartyType, rawId: string, rawQuery: unknown) {
  const notFound = type === "CUSTOMER" ? "Shop not found." : "Supplier not found.";
  const id = idOr404(rawId, notFound);
  const q = parseOrRefuse(statementQuerySchema, rawQuery);
  if (q.from && q.to && q.from > q.to) throw new BusinessRuleError(["The “From” date is after the “To” date."]);
  const s = await loadStatement(db, type, id, q);
  if (!s) throw new NotFoundError(notFound);
  return s;
}

@Controller("customers")
export class CustomerStatementController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id/statement")
  statement(@Param("id") id: string, @Query() query: unknown) {
    return statementOf(this.db, "CUSTOMER", id, query);
  }
}

@Controller("suppliers")
export class SupplierStatementController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id/statement")
  statement(@Param("id") id: string, @Query() query: unknown) {
    return statementOf(this.db, "SUPPLIER", id, query);
  }
}

/** Reference data the printed pages and the filters need. */
@Controller()
export class ReferenceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The whitelisted display fields of the company profile — never the whole settings document. */
  @RequirePermission("MASTER_DATA_VIEW")
  @Get("company")
  company() {
    return loadCompany(this.db);
  }

  @RequirePermission("MASTER_DATA_VIEW")
  @Get("regions")
  regions() {
    return listRegions(this.db);
  }
}
