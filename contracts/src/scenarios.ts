import { z } from "zod";
import { DateBalance, isoDate, money } from "./common";
import { IndicatorId, IndicatorStatus } from "./facts";

export const Scenario = z.discriminatedUnion("type", [
  z.object({ type: z.literal("purchase_now"), amount: money.positive(), label: z.string().optional() }),
  z.object({ type: z.literal("lose_income"), months: z.number().int().positive() }),
  z.object({ type: z.literal("one_time_expense"), amount: money.positive(), date: isoDate, label: z.string().optional() }),
  z.object({
    type: z.literal("new_recurring"),
    amount: money.positive(),
    dayOfMonth: z.number().int().min(1).max(28),
    label: z.string(),
  }),
]);
export type Scenario = z.infer<typeof Scenario>;

export const WhatIfSide = z.object({
  lowestBalance: DateBalance,
  firstNegativeDate: isoDate.nullable(),
  runwayMonths: z.number(),
  indicatorStatuses: z.record(z.string(), IndicatorStatus),
});
export type WhatIfSide = z.infer<typeof WhatIfSide>;

export const WhatIfResult = z.object({
  schemaVersion: z.literal(1),
  scenario: Scenario,
  before: WhatIfSide,
  after: WhatIfSide,
  changedIndicators: z.array(z.object({ id: IndicatorId, from: IndicatorStatus, to: IndicatorStatus })),
  /** Days from today until the first negative balance after the scenario; null if it never goes negative. */
  daysUntilNegative: z.number().int().nullable(),
});
export type WhatIfResult = z.infer<typeof WhatIfResult>;
