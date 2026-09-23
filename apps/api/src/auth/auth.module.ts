import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { SessionGuard } from "./session.guard.js";
import { PermissionGuard } from "./permission.guard.js";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    // Order matters: SessionGuard populates request.user before PermissionGuard checks it.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
