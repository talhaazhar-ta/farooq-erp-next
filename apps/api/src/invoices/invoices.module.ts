import { Module } from "@nestjs/common";
import { CLOCK, systemClock } from "../payments/clock.js";
import { InvoiceLookupsController, InvoicesController } from "./invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";

@Module({
  controllers: [InvoicesController, InvoiceLookupsController],
  providers: [InvoicesService, { provide: CLOCK, useValue: systemClock }],
  exports: [InvoicesService],
})
export class InvoicesModule {}
