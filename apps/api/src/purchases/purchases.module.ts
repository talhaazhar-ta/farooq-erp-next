import { Module } from "@nestjs/common";
import { CLOCK, systemClock } from "../payments/clock.js";
import { PurchasesController } from "./purchases.controller.js";
import { PurchasesService } from "./purchases.service.js";

@Module({
  controllers: [PurchasesController],
  providers: [PurchasesService, { provide: CLOCK, useValue: systemClock }],
  exports: [PurchasesService],
})
export class PurchasesModule {}
