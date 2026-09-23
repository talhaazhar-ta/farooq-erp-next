import { startTestDatabase } from "@farooq/db/testing";

let stop: (() => Promise<void>) | undefined;

export async function setup(): Promise<void> {
  stop = await startTestDatabase();
}

export async function teardown(): Promise<void> {
  await stop?.();
}
