import { z } from "zod";
import { AccountId, CharacterId, DateBalance, isoDate, isoDateTime, money } from "./common";
import { FinanceEvent } from "./events";

export const FORECAST_DAYS = 45;

export const Account = z.object({
  id: AccountId,
  kind: z.enum(["checking", "savings", "credit_card", "car_loan", "ira"]),
  name: z.string(),
  characterId: CharacterId,
  /** Credit card and car loan: the amount owed. */
  balance: money,
  /** True when the values are made up locally because Nessie does not model them. */
  simulated: z.boolean().optional(),
  limit: money.optional(),
  aprPercent: z.number().optional(),
  minimumPayment: money.optional(),
  monthlyPayment: money.optional(),
  retirementTarget: money.optional(),
  employerMatchPercent: z.number().optional(),
  userContributionPercent: z.number().optional(),
  unclaimedMatchThisYear: money.optional(),
  daysSinceLastContribution: z.number().int().optional(),
});
export type Account = z.infer<typeof Account>;

export const Bill = z.object({
  id: z.string(),
  label: z.string(),
  amount: money,
  dueDate: isoDate,
  essential: z.boolean(),
});
export type Bill = z.infer<typeof Bill>;

export const Paycheck = z.object({ date: isoDate, amount: money });
export type Paycheck = z.infer<typeof Paycheck>;

/**
 * 45 days starting on the customer's local date (day 0 is today, including today's spending).
 * For each day, in order: add the paycheck if it is payday, subtract bills due that day,
 * subtract the average daily discretionary spend, record the end-of-day balance.
 */
export const Forecast = z.object({
  startDate: isoDate,
  endDate: isoDate,
  days: z.array(DateBalance).length(FORECAST_DAYS),
  lowest: DateBalance,
  /** Lowest end-of-day balance on any day before the next payday. */
  lowestBeforeNextPayday: DateBalance,
  firstNegativeDate: isoDate.nullable(),
  firstBelowCushionDate: isoDate.nullable(),
  cushion: money,
  /** First payday strictly after today. */
  nextPayday: isoDate,
  /** lowestBeforeNextPayday.balance minus the cushion. Negative means you are short. */
  safeToSpendUntilPayday: money,
});
export type Forecast = z.infer<typeof Forecast>;

export const IndicatorId = z.enum([
  "runway",
  "credit_utilization",
  "savings_rate",
  "bill_reliability",
  "retirement_on_track",
]);
export type IndicatorId = z.infer<typeof IndicatorId>;

export const IndicatorStatus = z.enum(["good", "watch", "concern"]);
export type IndicatorStatus = z.infer<typeof IndicatorStatus>;

/**
 * higher_is_better: good if value >= goodAt, concern if value < concernAt, otherwise watch.
 * lower_is_better:  good if value <  goodAt, concern if value >= concernAt, otherwise watch.
 * goodAt and concernAt are included so characters may quote them without tripping the number checker.
 */
export const Indicator = z.object({
  id: IndicatorId,
  label: z.string(),
  value: z.number(),
  unit: z.enum(["months", "percent", "count"]),
  status: IndicatorStatus,
  direction: z.enum(["higher_is_better", "lower_is_better"]),
  goodAt: z.number(),
  concernAt: z.number(),
  ownerCharacter: CharacterId,
  /** The raw numbers the value was computed from. */
  inputs: z.record(z.string(), z.number()),
});
export type Indicator = z.infer<typeof Indicator>;

export const ProposalStatus = z.enum(["pending", "accepted", "declined", "expired", "completed"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** Read-only view of a proposal. The proposals table and its rules belong to the agents service. */
export const ProposalSummary = z.object({
  id: z.string(),
  actionText: z.string(),
  amount: money,
  from: AccountId,
  to: AccountId,
  status: ProposalStatus,
  expiresAt: isoDateTime,
});
export type ProposalSummary = z.infer<typeof ProposalSummary>;

export const Shortfall = z.object({
  firstNegativeDate: isoDate,
  /** Day of the lowest negative balance before the next payday. */
  lowestDate: isoDate,
  /** How far below zero the balance gets at its lowest. */
  amount: money,
  accountId: AccountId,
  /** Hours from asOf until the end of the first negative day (local time). */
  hoursUntilFirstShortDayEnds: z.number(),
  within48Hours: z.boolean(),
  /** amount plus the cushion: the transfer that fixes it. */
  suggestedTransfer: money,
});
export type Shortfall = z.infer<typeof Shortfall>;

export const FactsSnapshot = z.object({
  schemaVersion: z.literal(1),
  /** Always produced from now(), never the raw clock. */
  asOf: isoDateTime,
  localDate: isoDate,
  timezone: z.string(),
  customer: z.object({ id: z.string(), firstName: z.string() }),
  /** Fields that are simulated rather than real Nessie data. */
  simulatedFields: z.array(z.string()),
  accounts: z.array(Account),
  /** Bills due in the next 30 days. */
  upcomingBills: z.array(Bill),
  upcomingPaychecks: z.array(Paycheck),
  forecast: Forecast,
  indicators: z.array(Indicator).length(5),
  pendingProposals: z.array(ProposalSummary),
  recentEvents: z.array(FinanceEvent),
  /** Null when no day in the forecast is negative. */
  shortfall: Shortfall.nullable(),
});
export type FactsSnapshot = z.infer<typeof FactsSnapshot>;
