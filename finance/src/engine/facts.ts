import {
  FORECAST_DAYS,
  localDate,
  type Account,
  type Bill,
  type DateBalance,
  type FactsSnapshot,
  type FinanceEvent,
  type Forecast,
  type Indicator,
  type Paycheck,
  type Persona,
  type ProposalSummary,
  type Shortfall,
} from "../../../contracts/src";
import { THRESHOLDS } from "../data/config";
import { addDays, billDueOn, endOfLocalDay, isPayday, nextPaydayAfter, paydaysBetween, r2 } from "./calendar";
import { last30Days, type LedgerState } from "./ledger";

/** Changes layered on the forecast by a what-if. The real forecast uses none. */
export interface ForecastMods {
  extraOutflows?: { date: string; amount: number }[];
  extraRecurring?: { dayOfMonth: number; amount: number }[];
  /** No paychecks on or before this date. */
  noPaychecksThrough?: string;
}

/**
 * 45 days from `today` (day 0 includes today's spending). For each day, in order: add the paycheck if it is
 * payday, subtract bills due, subtract the average daily spend, record the end-of-day balance.
 */
export function forecastDays(state: LedgerState, persona: Persona, today: string, mods: ForecastMods = {}): DateBalance[] {
  let balance = state.balances.checking;
  const days: DateBalance[] = [];
  for (let i = 0; i < FORECAST_DAYS; i++) {
    const date = addDays(today, i);
    const paid = isPayday(state.lastPaid, persona.income.everyDays, date) && !(mods.noPaychecksThrough && date <= mods.noPaychecksThrough);
    if (paid) balance += state.paycheckAmount;
    for (const b of persona.recurringBills) if (billDueOn(b.dayOfMonth, date)) balance -= b.amount;
    for (const b of state.oneOffBills) if (!b.paid && b.dueDate === date) balance -= b.amount;
    for (const r of mods.extraRecurring ?? []) if (billDueOn(r.dayOfMonth, date)) balance -= r.amount;
    for (const o of mods.extraOutflows ?? []) if (o.date === date) balance -= o.amount;
    balance -= persona.spending.averageDailyDiscretionary;
    balance = r2(balance);
    days.push({ date, balance });
  }
  return days;
}

const lowestOf = (days: DateBalance[]): DateBalance => days.reduce((low, d) => (d.balance < low.balance ? d : low));

export function buildForecast(state: LedgerState, persona: Persona, today: string, days = forecastDays(state, persona, today)): Forecast {
  const cushion = THRESHOLDS.cushion;
  const nextPayday = nextPaydayAfter(state.lastPaid, persona.income.everyDays, today);
  const lowestBefore = lowestOf(days.filter((d) => d.date < nextPayday));
  return {
    startDate: days[0]!.date,
    endDate: days[days.length - 1]!.date,
    days,
    lowest: lowestOf(days),
    lowestBeforeNextPayday: lowestBefore,
    firstNegativeDate: days.find((d) => d.balance < 0)?.date ?? null,
    firstBelowCushionDate: days.find((d) => d.balance < cushion)?.date ?? null,
    cushion,
    nextPayday,
    safeToSpendUntilPayday: r2(lowestBefore.balance - cushion),
  };
}

export function buildShortfall(forecast: Forecast, asOf: Date, timeZone: string): Shortfall | null {
  if (!forecast.firstNegativeDate) return null;
  const negative = forecast.days.filter((d) => d.balance < 0);
  const beforePayday = negative.filter((d) => d.date < forecast.nextPayday);
  const lowest = lowestOf(beforePayday.length > 0 ? beforePayday : negative);
  const hours = Math.round(((endOfLocalDay(forecast.firstNegativeDate, timeZone).getTime() - asOf.getTime()) / 3_600_000) * 10) / 10;
  return {
    firstNegativeDate: forecast.firstNegativeDate,
    lowestDate: lowest.date,
    amount: r2(-lowest.balance),
    accountId: "checking",
    hoursUntilFirstShortDayEnds: hours,
    within48Hours: hours <= THRESHOLDS.shortfallEscalationHours,
    suggestedTransfer: r2(-lowest.balance + forecast.cushion),
  };
}

function statusOf(value: number, t: { direction: string; goodAt: number; concernAt: number }): Indicator["status"] {
  if (t.direction === "higher_is_better") return value >= t.goodAt ? "good" : value < t.concernAt ? "concern" : "watch";
  return value < t.goodAt ? "good" : value >= t.concernAt ? "concern" : "watch";
}

export function monthlyEssentials(persona: Persona): number {
  const bills = persona.recurringBills.filter((b) => b.essential).reduce((s, b) => s + b.amount, 0);
  return r2(bills + persona.spending.essentialDailySpend * 30);
}

/**
 * The five health indicators, each with the raw numbers it came from.
 * `income30` overrides the 30-day income (a what-if where paychecks stop): the savings rate is then
 * (0 - spending) / spending, which is -100 percent.
 */
export function buildIndicators(state: LedgerState, persona: Persona, today: string, opts: { income30?: number } = {}): Indicator[] {
  const essentials = monthlyEssentials(persona);
  const limit = persona.accounts.card.limit;
  const ira = persona.accounts.ira;
  const window = last30Days(state, persona, today);
  const income = opts.income30 ?? window.income;
  const rate = opts.income30 === 0 ? (window.spending > 0 ? -100 : 0) : income > 0 ? ((income - window.spending) / income) * 100 : 0;
  const rows: Array<[Indicator["id"], string, number, Record<string, number>, Indicator["ownerCharacter"]]> = [
    ["runway", "Runway", state.balances.savings / essentials, { savings: state.balances.savings, monthlyEssentials: essentials }, "savings"],
    ["credit_utilization", "Credit utilization", (state.balances.card / limit) * 100, { cardBalance: state.balances.card, cardLimit: limit }, "card"],
    ["savings_rate", "Savings rate (30 days)", rate, { income30d: income, spending30d: window.spending }, "savings"],
    ["bill_reliability", "Bill reliability", state.onTimeBillStreak, { streak: state.onTimeBillStreak }, "checking"],
    ["retirement_on_track", "Retirement on track", (state.balances.ira / ira.retirementTarget) * 100, { iraBalance: state.balances.ira, target: ira.retirementTarget }, "ira"],
  ];
  return rows.map(([id, label, raw, inputs, ownerCharacter]) => {
    const t = THRESHOLDS.indicators[id]!;
    const value = id === "runway" ? Math.round(raw * 100) / 100 : id === "bill_reliability" ? raw : Math.round(raw * 10) / 10;
    return { id, label, value, unit: t.unit, status: statusOf(value, t), direction: t.direction, goodAt: t.goodAt, concernAt: t.concernAt, ownerCharacter, inputs };
  });
}

function buildAccounts(state: LedgerState, persona: Persona): Account[] {
  const a = persona.accounts;
  return [
    { id: "checking", kind: "checking", name: "Checking", characterId: "checking", balance: state.balances.checking },
    { id: "savings", kind: "savings", name: "Savings", characterId: "savings", balance: state.balances.savings },
    {
      id: "card", kind: "credit_card", name: "Credit Card", characterId: "card", balance: state.balances.card, simulated: true,
      limit: a.card.limit, aprPercent: a.card.aprPercent, minimumPayment: a.card.minimumPayment,
    },
    {
      id: "car_loan", kind: "car_loan", name: "Car Loan", characterId: "car_loan", balance: state.balances.car_loan, simulated: true,
      aprPercent: a.carLoan.aprPercent, monthlyPayment: a.carLoan.monthlyPayment,
    },
    {
      id: "ira", kind: "ira", name: "IRA", characterId: "ira", balance: state.balances.ira, simulated: true,
      retirementTarget: a.ira.retirementTarget, employerMatchPercent: a.ira.employerMatchPercent, userContributionPercent: a.ira.userContributionPercent,
      unclaimedMatchThisYear: a.ira.unclaimedMatchThisYear, daysSinceLastContribution: state.daysSinceLastContribution,
    },
  ];
}

/** Bills due in the next 30 days, day by day: recurring bills in persona order, then one-off bills. */
function upcomingBills(state: LedgerState, persona: Persona, today: string): Bill[] {
  const out: Bill[] = [];
  for (let i = 0; i <= 30; i++) {
    const date = addDays(today, i);
    for (const b of persona.recurringBills) {
      if (billDueOn(b.dayOfMonth, date)) out.push({ id: b.id, label: b.label, amount: b.amount, dueDate: date, essential: b.essential });
    }
    for (const b of state.oneOffBills) {
      if (!b.paid && b.dueDate === date) out.push({ id: b.id, label: b.label, amount: b.amount, dueDate: date, essential: b.essential });
    }
  }
  return out;
}

function upcomingPaychecks(state: LedgerState, persona: Persona, today: string): Paycheck[] {
  return paydaysBetween(state.lastPaid, persona.income.everyDays, today, addDays(today, FORECAST_DAYS))
    .slice(0, 3)
    .map((date) => ({ date, amount: state.paycheckAmount }));
}

export interface FactsExtras {
  events: FinanceEvent[];
  proposals: ProposalSummary[];
}

/** The ledger must already be settled through yesterday. `now` is the shared clock's now(), never the raw clock. */
export function buildFacts(state: LedgerState, persona: Persona, now: Date, extras: FactsExtras = { events: [], proposals: [] }): FactsSnapshot {
  const timezone = persona.customer.timezone;
  const today = localDate(now, timezone);
  const forecast = buildForecast(state, persona, today);
  return {
    schemaVersion: 1,
    asOf: now.toISOString(),
    localDate: today,
    timezone,
    customer: { id: persona.customer.id, firstName: persona.customer.firstName },
    simulatedFields: persona.simulatedFields,
    accounts: buildAccounts(state, persona),
    upcomingBills: upcomingBills(state, persona, today),
    upcomingPaychecks: upcomingPaychecks(state, persona, today),
    forecast,
    indicators: buildIndicators(state, persona, today),
    pendingProposals: extras.proposals,
    recentEvents: extras.events,
    shortfall: buildShortfall(forecast, now, timezone),
  };
}
