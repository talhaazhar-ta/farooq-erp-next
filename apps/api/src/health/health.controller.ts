import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/permission.decorator.js";

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: "ok", time: new Date().toISOString() };
  }
}
