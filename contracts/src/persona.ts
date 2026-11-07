import { z } from "zod";
import { isoDate, money } from "./common";

/** Shape of persona.json, the demo customer used by the seed script and the persona data source. */
export const Persona = z.object({
  version: z.literal(1),
  customer: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    age: z.number().int(),
    timezone: z.string(),
  }),
  accounts: z.object({
    checking: z.object({ balance: money }),
    savings: z.object({ balance: money }),
    card: z.object({ balance: money, limit: money, aprPercent: z.number(), minimumPayment: money }),
    carLoan: z.object({ balance: money, aprPercent: z.number(), monthlyPayment: money }),
    ira: z.object({
      balance: money,
      retirementTarget: money,
      employerMatchPercent: z.number(),
      userContributionPercent: z.number(),
      unclaimedMatchThisYear: money,
      daysSinceLastContribution: z.number().int(),
    }),
  }),
  income: z.object({ paycheckAmount: money, everyDays: z.number().int(), lastPaidDaysAgo: z.number().int() }),
  recurringBills: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      amount: money,
      dayOfMonth: z.number().int().min(1).max(28),
      essential: z.boolean(),
    }),
  ),
  spending: z.object({
    averageDailyDiscretionary: money,
    essentialDailySpend: money,
    last30Days: z.object({ income: money, spending: money }),
    onTimeBillStreak: z.number().int(),
  }),
  goals: z.array(
    z.object({ id: z.string(), label: z.string(), target: money, saved: money, deadline: isoDate }),
  ),
  peers: z.array(z.object({ name: z.string(), relationship: z.string(), owesUser: money })),
  seedHints: z.object({
    historyDays: z.number().int(),
    merchants: z.array(
      z.object({
        name: z.string(),
        category: z.string(),
        typicalAmount: z.tuple([z.number(), z.number()]),
        perWeek: z.number(),
      }),
    ),
  }),
  simulatedFields: z.array(z.string()),
});
export type Persona = z.infer<typeof Persona>;
