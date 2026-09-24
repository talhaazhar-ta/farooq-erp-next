import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }));

  await app.register(fastifyCookie);
  // Content-Disposition is exposed so the browser can read the CSV export's file name across origins.
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true, exposedHeaders: ["Content-Disposition"] });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
  console.log(`API listening on :${port}`);
}

bootstrap();
