import { types } from "pg";

// node-postgres returns BIGINT (int8, OID 20) as a string by default, to
// avoid silent precision loss past 2^53. Every id here is a BIGINT
// IDENTITY column and every count(*) is int8, so in practice that meant
// ids crossed the API as "12" while all the TS row types said `number` -
// clients had to Number() at every comparison (or silently compared "4"
// to 4 and got false). Parse them as real numbers instead, and fail loudly
// rather than round if a value ever doesn't fit.
//
// Global per pg module instance: import this (for its side effect) from
// every file that constructs a Pool, so it's registered no matter which
// module loads first. Re-registering is harmless.
export const INT8_OID = 20;

export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BIGINT value ${value} is outside the safe integer range`);
  }
  return n;
}

types.setTypeParser(INT8_OID, parseInt8);
