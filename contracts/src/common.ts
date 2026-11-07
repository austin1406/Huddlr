import { z } from "zod";

/** Calendar day in the customer's timezone, e.g. "2026-11-07". */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Instant with an explicit offset, e.g. "2026-11-07T16:00:00.000Z". Always generated from now(). */
export const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "expected an ISO date-time");

/** Dollars as a plain number, rounded to cents. Credit card and loan balances are the amount owed. */
export const money = z.number().finite();

export const AccountId = z.enum(["checking", "savings", "card", "car_loan", "ira"]);
export type AccountId = z.infer<typeof AccountId>;

export const CharacterId = z.enum(["checking", "savings", "card", "car_loan", "ira", "coach"]);
export type CharacterId = z.infer<typeof CharacterId>;

export const DateBalance = z.object({ date: isoDate, balance: money });
export type DateBalance = z.infer<typeof DateBalance>;
