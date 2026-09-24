import { Module } from "@nestjs/common";
import { CustomerStatementController, ReferenceController, SupplierStatementController } from "./statements.controller.js";

@Module({ controllers: [CustomerStatementController, SupplierStatementController, ReferenceController] })
export class StatementsModule {}
