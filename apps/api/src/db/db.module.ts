import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDb, type Db } from "./client.js";

export const DB = Symbol("DB");

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Db => {
        const url = config.getOrThrow<string>("APP_DATABASE_URL");
        return createDb(url).db;
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
