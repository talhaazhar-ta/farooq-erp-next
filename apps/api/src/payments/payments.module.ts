import { Module } from "@nestjs/common";
import { CLOCK, systemClock } from "./clock.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { CustomersController, SuppliersController } from "./parties.controller.js";

@Module({
  controllers: [PaymentsController, CustomersController, SuppliersController],
  providers: [PaymentsService, { provide: CLOCK, useValue: systemClock }],
  exports: [PaymentsService],
})
export class PaymentsModule {}
