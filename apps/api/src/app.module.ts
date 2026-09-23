import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DbModule } from "./db/db.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { HealthController } from "./health/health.controller.js";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DbModule, AuthModule, PaymentsModule],
  controllers: [HealthController],
})
export class AppModule {}
