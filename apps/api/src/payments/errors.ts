import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * A business-rule or validation refusal: HTTP 422 with `{ message, errors }`. `message` is the first error (what a
 * toast shows); `errors` lists all of them. The wording is the legacy wording wherever a legacy rule exists.
 */
export class BusinessRuleError extends HttpException {
  constructor(public readonly errors: string[]) {
    super({ message: errors[0] ?? "The request was refused.", errors }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/** HTTP 404 with the same `{ message, errors }` body. */
export class NotFoundError extends HttpException {
  constructor(message: string) {
    super({ message, errors: [message] }, HttpStatus.NOT_FOUND);
  }
}

interface SafeParsable<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
}

/** Parses `input` with a Zod schema; any failure is a 422 listing every problem (unknown fields included). */
export function parseOrRefuse<T>(schema: SafeParsable<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new BusinessRuleError([...new Set(result.error.issues.map((i) => i.message))]);
}
