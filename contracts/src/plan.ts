import { z } from "zod";
import { AccountId, isoDateTime, money } from "./common";

/** An account, or a savings goal written as "goal:<id>". */
export const PlanDestination = z.union([AccountId, z.string().regex(/^goal:.+/)]);
export type PlanDestination = z.infer<typeof PlanDestination>;

export const PlanReasonCode = z.enum([
  "cover_shortfall",
  "capture_employer_match",
  "pay_high_interest_debt",
  "build_emergency_fund",
  "fund_goal",
  "extra_retirement",
  "extra_debt_payment",
]);
export type PlanReasonCode = z.infer<typeof PlanReasonCode>;

export const PlanLine = z.object({
  destination: PlanDestination,
  amount: money,
  reasonCode: PlanReasonCode,
  /** Numbers the Coach may quote to explain this line. */
  reasonNumbers: z.record(z.string(), z.number()),
});
export type PlanLine = z.infer<typeof PlanLine>;

/**
 * The Coach's plan for a sum of money. The shape is the contract; plan v0 (simple rules) and
 * optimizer v1 (full priority order) return exactly this. Invariant:
 * sum(lines.amount) + unallocated = amount.
 */
export const Plan = z.object({
  schemaVersion: z.literal(1),
  asOf: isoDateTime,
  amount: money,
  shortfallCovered: money,
  unallocated: money,
  lines: z.array(PlanLine),
});
export type Plan = z.infer<typeof Plan>;
