/** Injectable clock: business dates and receipt-number years come from here so a test can pin "now". */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

export const systemClock: Clock = { now: () => new Date() };
