import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { partyLookupQuerySchema } from "@farooq/shared";
import type { Db } from "@farooq/db";
import { RequireAnyPermission, RequirePermission } from "../auth/permission.decorator.js";
import { DB } from "../db/db.module.js";
import { NotFoundError, parseOrRefuse } from "./errors.js";
import { PAYMENT_READ_PERMISSIONS, idOr404 } from "./payments.controller.js";
import {
  customerBalance,
  lookupCustomers,
  lookupSuppliers,
  outstandingInvoices,
  outstandingPurchases,
  supplierBalance,
} from "./payments.queries.js";

/**
 * Read-only lookups the S4 Receive / Pay panels need: pickers, journal-derived balances, and the documents a
 * payment can be allocated to. Master-data CRUD is a later milestone; this is only what payments needs.
 */

@Controller("customers")
export class CustomersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("MASTER_DATA_VIEW")
  @Get()
  lookup(@Query() query: unknown) {
    return lookupCustomers(this.db, parseOrRefuse(partyLookupQuerySchema, query));
  }

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id/balance")
  async balance(@Param("id") id: string) {
    const partyId = idOr404(id, "Shop not found.");
    const balanceP = await customerBalance(this.db, partyId);
    if (balanceP === null) throw new NotFoundError("Shop not found.");
    return { partyId, balanceP };
  }

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id/outstanding-invoices")
  async outstanding(@Param("id") id: string) {
    const rows = await outstandingInvoices(this.db, idOr404(id, "Shop not found."));
    if (!rows) throw new NotFoundError("Shop not found.");
    return rows;
  }
}

@Controller("suppliers")
export class SuppliersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("MASTER_DATA_VIEW")
  @Get()
  lookup(@Query() query: unknown) {
    return lookupSuppliers(this.db, parseOrRefuse(partyLookupQuerySchema, query));
  }

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id/balance")
  async balance(@Param("id") id: string) {
    const partyId = idOr404(id, "Supplier not found.");
    const balanceP = await supplierBalance(this.db, partyId);
    if (balanceP === null) throw new NotFoundError("Supplier not found.");
    return { partyId, balanceP };
  }

  @RequireAnyPermission(...PAYMENT_READ_PERMISSIONS)
  @Get(":id/outstanding-purchases")
  async outstanding(@Param("id") id: string) {
    const rows = await outstandingPurchases(this.db, idOr404(id, "Supplier not found."));
    if (!rows) throw new NotFoundError("Supplier not found.");
    return rows;
  }
}
