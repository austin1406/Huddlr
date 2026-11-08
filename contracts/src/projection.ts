import { z } from "zod";
import { DateBalance, isoDate, isoDateTime, money } from "./common";

/**
 * Long-range projection: "if things stay the way they are, how do my accounts and net worth change over the next
 * N days, weeks, months or years?" Unlike the 45-day forecast (checking only, today's calendar), this follows every
 * account: checking, savings, card, car loan and IRA, with interest and loan payoffs. Every assumption is listed in
 * the response so a character or the page can say it out loud.
 */
export const ProjectionUnit = z.enum(["days", "weeks", "months", "years"]);
export type ProjectionUnit = z.infer<typeof ProjectionUnit>;

const MAX_BY_UNIT: Record<ProjectionUnit, number> = { days: 3650, weeks: 520, months: 120, years: 10 };

export const ProjectionRequest = z
  .object({
    amount: z.number().int().positive(),
    unit: ProjectionUnit,
    /** Also return the same window if the Coach's plan were followed every month. */
    compare: z.boolean().optional(),
    /** Yearly growth assumed for the IRA. Default 0: contributions only, no market growth is assumed. */
    iraReturnPercent: z.number().min(0).max(15).optional(),
    /** Yearly interest assumed on savings. Default 0. */
    savingsApyPercent: z.number().min(0).max(10).optional(),
    /**
     * learned (default): everyday spending is learned from the ledger's history, recurring payments are found, and many
     * simulated futures give a likely range. simple: the profile's flat daily average, no range (the original model).
     */
    model: z.enum(["learned", "simple"]).optional(),
    /** Simulated futures for the likely range. Default 300; 0 turns the range off. */
    runs: z.number().int().min(0).max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.amount > MAX_BY_UNIT[v.unit]) {
      ctx.addIssue({ code: "custom", path: ["amount"], message: `at most ${MAX_BY_UNIT[v.unit]} ${v.unit} (10 years)` });
    }
  });
export type ProjectionRequest = z.infer<typeof ProjectionRequest>;

/** End-of-day balances. Card and car loan are the amount owed. netWorth = checking + savings + ira - card - carLoan. */
export const ProjectionPoint = z.object({
  date: isoDate,
  checking: money,
  savings: money,
  ira: money,
  card: money,
  carLoan: money,
  assets: money,
  liabilities: money,
  netWorth: money,
});
export type ProjectionPoint = z.infer<typeof ProjectionPoint>;

export const ProjectionSummary = z.object({
  startNetWorth: money,
  endNetWorth: money,
  change: money,
  lowestChecking: DateBalance,
  /** First day checking would go below zero, or null. */
  firstNegativeDate: isoDate.nullable(),
  /** Null when the debt is not paid off inside the window. */
  cardPaidOffDate: isoDate.nullable(),
  carLoanPaidOffDate: isoDate.nullable(),
  /** Interest charged on the card and the car loan inside the window. */
  interestPaid: money,
  /** Savings expressed in months of essential spending, at the end of the window. */
  emergencyFundMonthsEnd: z.number(),
  /** Average a month that checking gains (current course only; null for the Coach's plan, which moves money out). */
  avgMonthlyChangeInChecking: money.nullable(),
});
export type ProjectionSummary = z.infer<typeof ProjectionSummary>;

/** What the model believes about everyday spending, and what it found. */
export const ProjectionModel = z.object({
  kind: z.enum(["learned", "simple"]),
  dailySpendMean: money,
  /** How much a single day varies around the mean. */
  dailySpendSd: money,
  /** profile: no spending history yet, the profile's belief is used. history: learned from observed days. */
  basis: z.enum(["profile", "history"]),
  daysObserved: z.number().int(),
  /** 0 to 1: how much of the estimate came from history rather than the profile. */
  weightOnHistory: z.number(),
  /** Payments nobody told the engine about that repeat on a rhythm, now included in the projection. */
  detectedRecurring: z.array(z.object({ label: z.string(), amount: money, everyDays: z.number().int(), nextDate: isoDate, seen: z.number().int() })),
});
export type ProjectionModel = z.infer<typeof ProjectionModel>;

/** The middle 80% of simulated futures, one value per entry in `points`, plus risk numbers for the whole window. */
export const ProjectionUncertainty = z.object({
  runs: z.number().int(),
  p10: z.array(money),
  p50: z.array(money),
  p90: z.array(money),
  endNetWorth: z.object({ p10: money, p50: money, p90: money }),
  /** Share of simulated futures in which checking goes below zero on at least one day (0 to 1). */
  probCheckingNegative: z.number(),
  /** Share of simulated futures in which the card is fully paid by the end of the window (0 to 1). */
  probCardPaidOffByEnd: z.number(),
});
export type ProjectionUncertainty = z.infer<typeof ProjectionUncertainty>;

export const Projection = z.object({
  strategy: z.enum(["current", "coach"]),
  /** The accounts right now, before the first projected day. */
  start: ProjectionPoint,
  /** Daily for windows up to 120 days, weekly up to about 2 years, otherwise every 30 days. The last day is always included. */
  points: z.array(ProjectionPoint).min(1),
  summary: ProjectionSummary,
  assumptions: z.array(z.string()),
  model: ProjectionModel.optional(),
  /** Null when the likely range is off (runs 0) or the model is simple. */
  uncertainty: ProjectionUncertainty.nullable().optional(),
});
export type Projection = z.infer<typeof Projection>;

export const ProjectionResponse = z.object({
  schemaVersion: z.literal(1),
  asOf: isoDateTime,
  startDate: isoDate,
  endDate: isoDate,
  days: z.number().int().positive(),
  /** The path if nothing changes. */
  current: Projection,
  /** The path if the Coach's plan were followed every month. Present when compare is true. */
  coach: Projection.nullable(),
  /** coach minus current, at the end of the window. Present when compare is true. */
  difference: z
    .object({ netWorth: money, interestPaid: money, cardPaidOffDaysEarlier: z.number().int().nullable() })
    .nullable(),
});
export type ProjectionResponse = z.infer<typeof ProjectionResponse>;
