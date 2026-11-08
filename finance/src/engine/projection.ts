import type { FactsSnapshot, Persona, Projection, ProjectionPoint, ProjectionRequest, ProjectionResponse } from "../../../contracts/src";
import { THRESHOLDS } from "../data/config";
import { addDays, billDueOn, daysBetween, isPayday, lastDayOfMonth, r2 } from "./calendar";
import type { LedgerState } from "./ledger";
import { monthlyEssentials } from "./facts";
import { planV1 } from "./optimizer";

export interface ProjectionOptions {
  days: number;
  iraReturnPercent: number;
  savingsApyPercent: number;
}

/** Window length in days from a start date. Months and years follow the calendar (Jan 31 plus one month is Feb 28). */
export function horizonDays(today: string, amount: number, unit: ProjectionRequest["unit"]): number {
  if (unit === "days") return amount;
  if (unit === "weeks") return amount * 7;
  const y = Number(today.slice(0, 4)),
    m = Number(today.slice(5, 7)) - 1,
    d = Number(today.slice(8, 10));
  const totalMonths = m + (unit === "years" ? amount * 12 : amount);
  const ty = y + Math.floor(totalMonths / 12),
    tm = totalMonths % 12;
  const end = new Date(Date.UTC(ty, tm, Math.min(d, new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate())));
  return daysBetween(today, end.toISOString().slice(0, 10));
}

/** Daily up to 120 days, weekly up to about two years, every 30 days beyond. */
export const strideFor = (days: number): number => (days <= 120 ? 1 : days <= 730 ? 7 : 30);

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const cents = (n: number) => Math.round(n * 100) / 100;

interface Balances {
  checking: number;
  savings: number;
  ira: number;
  card: number;
  carLoan: number;
}

const point = (date: string, b: Balances): ProjectionPoint => {
  const assets = r2(b.checking + b.savings + b.ira);
  const liabilities = r2(b.card + b.carLoan);
  return {
    date,
    checking: r2(b.checking),
    savings: r2(b.savings),
    ira: r2(b.ira),
    card: r2(b.card),
    carLoan: r2(b.carLoan),
    assets,
    liabilities,
    netWorth: r2(assets - liabilities),
  };
};

/**
 * Walks day by day from today with the rules the 45-day forecast uses (paycheck, bills, everyday spending; day 0 includes
 * today's spending) and adds what a long window needs: interest on the card and car loan, loan payoff, and optional
 * growth on savings and the IRA. "current" changes nothing. "coach" sends checking's surplus through plan v1 at every
 * month end.
 */
export function projectOne(
  strategy: "current" | "coach",
  state: LedgerState,
  persona: Persona,
  facts: FactsSnapshot,
  today: string,
  opts: ProjectionOptions,
): Projection {
  const a = persona.accounts;
  const bal: Balances = {
    checking: state.balances.checking,
    savings: state.balances.savings,
    ira: state.balances.ira,
    card: state.balances.card,
    carLoan: state.balances.car_loan,
  };
  const start = point(today, bal);
  const cushion = THRESHOLDS.cushion;
  const monthlyBills = persona.recurringBills.reduce((s, b) => s + b.amount, 0);
  const buffer = r2(monthlyBills + cushion);
  const essentials = monthlyEssentials(persona);

  // Coach state
  const goals = persona.goals.map((g) => ({ ...g }));
  let unclaimedMatch = a.ira.unclaimedMatchThisYear;
  const planFacts = structuredClone(facts);
  planFacts.shortfall = null;

  const stride = strideFor(opts.days);
  const points: ProjectionPoint[] = [];
  let lowest = { date: today, balance: Number.POSITIVE_INFINITY };
  let firstNegativeDate: string | null = null;
  let cardPaidOffDate: string | null = bal.card <= 0 ? today : null;
  let carLoanPaidOffDate: string | null = bal.carLoan <= 0 ? today : null;
  let interest = 0;
  const startChecking = bal.checking;

  for (let i = 0; i < opts.days; i++) {
    const date = addDays(today, i);

    if (isPayday(state.lastPaid, persona.income.everyDays, date)) bal.checking += state.paycheckAmount;

    for (const b of persona.recurringBills) {
      if (!billDueOn(b.dayOfMonth, date)) continue;
      if (b.id === "car_loan") {
        const charged = (bal.carLoan * a.carLoan.aprPercent) / 1200;
        bal.carLoan += charged;
        interest += charged;
        const pay = Math.min(b.amount, bal.carLoan);
        bal.carLoan -= pay;
        bal.checking -= pay;
      } else if (b.id === "card_minimum") {
        const charged = (bal.card * a.card.aprPercent) / 1200;
        bal.card += charged;
        interest += charged;
        const pay = Math.min(b.amount, bal.card);
        bal.card -= pay;
        bal.checking -= pay;
      } else {
        bal.checking -= b.amount;
      }
    }
    for (const b of state.oneOffBills) if (!b.paid && b.dueDate === date) bal.checking -= b.amount;
    bal.checking -= persona.spending.averageDailyDiscretionary;

    if (date.slice(8, 10) === String(lastDayOfMonth(date)).padStart(2, "0")) {
      bal.savings *= 1 + opts.savingsApyPercent / 1200;
      bal.ira *= 1 + opts.iraReturnPercent / 1200;

      if (strategy === "coach" && bal.checking - buffer > 0.01) {
        const surplus = r2(bal.checking - buffer);
        for (const acct of planFacts.accounts) {
          if (acct.id === "checking") acct.balance = r2(bal.checking);
          else if (acct.id === "savings") acct.balance = r2(bal.savings);
          else if (acct.id === "card") acct.balance = r2(bal.card);
          else if (acct.id === "car_loan") acct.balance = r2(bal.carLoan);
          else if (acct.id === "ira") {
            acct.balance = r2(bal.ira);
            acct.unclaimedMatchThisYear = r2(unclaimedMatch);
          }
        }
        for (const line of planV1(planFacts, goals, surplus).lines) {
          bal.checking -= line.amount;
          if (line.destination === "ira") {
            bal.ira += line.amount;
            if (line.reasonCode === "capture_employer_match") unclaimedMatch = Math.max(0, unclaimedMatch - line.amount);
          } else if (line.destination === "card") bal.card -= line.amount;
          else if (line.destination === "car_loan") bal.carLoan -= line.amount;
          else if (line.destination === "savings") bal.savings += line.amount;
          else if (line.destination.startsWith("goal:")) {
            bal.savings += line.amount;
            const g = goals.find((x) => `goal:${x.id}` === line.destination);
            if (g) g.saved += line.amount;
          }
        }
      }
    }

    if (bal.checking < lowest.balance) lowest = { date, balance: cents(bal.checking) };
    if (firstNegativeDate === null && bal.checking < 0) firstNegativeDate = date;
    if (cardPaidOffDate === null && bal.card < 0.005) cardPaidOffDate = date;
    if (carLoanPaidOffDate === null && bal.carLoan < 0.005) carLoanPaidOffDate = date;

    if ((i + 1) % stride === 0 || i === opts.days - 1) points.push(point(date, bal));
  }

  const end = points[points.length - 1]!;
  const months = opts.days / 30.4375;
  const idle = persona.recurringBills.find((b) => b.id === "rent");
  const assumptions = [
    `Paychecks of ${usd(state.paycheckAmount)} arrive every ${persona.income.everyDays} days and never change. No raises.`,
    `Bills repeat every month as they are today (${usd(monthlyBills)} a month, rent ${usd(idle?.amount ?? 0)} included).`,
    `Everyday spending stays at ${usd(persona.spending.averageDailyDiscretionary)} a day, paid from checking.`,
    `The card charges ${a.card.aprPercent}% a year, added each month. You pay the ${usd(a.card.minimumPayment)} minimum and add nothing new to it.`,
    `The car loan charges ${a.carLoan.aprPercent}% a year and you pay ${usd(a.carLoan.monthlyPayment)} a month until it is gone.`,
    opts.savingsApyPercent > 0 ? `Savings earns ${opts.savingsApyPercent}% a year.` : "Savings earns no interest (none is assumed).",
    opts.iraReturnPercent > 0
      ? `The IRA grows ${opts.iraReturnPercent}% a year with no new contributions. A guess, not a promise.`
      : "The IRA does not grow in this view (no market return is assumed) and gets no new contributions.",
    `${usd(a.ira.unclaimedMatchThisYear)} of employer match stays unclaimed${strategy === "coach" ? " until the plan captures it" : ""}.`,
    "The IRA and car loan are simulated; loans you add by text are not included.",
  ];
  if (strategy === "coach") {
    assumptions.push(
      `At each month end, money in checking above ${usd(buffer)} (a month of bills plus the ${usd(cushion)} cushion) is sent by the Coach's plan: employer match, then the card, then the emergency fund, goals, and the rest.`,
    );
  }

  return {
    strategy,
    start,
    points,
    summary: {
      startNetWorth: start.netWorth,
      endNetWorth: end.netWorth,
      change: r2(end.netWorth - start.netWorth),
      lowestChecking: lowest,
      firstNegativeDate,
      cardPaidOffDate: cardPaidOffDate === today && state.balances.card > 0 ? null : cardPaidOffDate,
      carLoanPaidOffDate: carLoanPaidOffDate === today && state.balances.car_loan > 0 ? null : carLoanPaidOffDate,
      interestPaid: r2(interest),
      emergencyFundMonthsEnd: r2(end.savings / essentials),
      avgMonthlyChangeInChecking: strategy === "current" ? r2((end.checking - startChecking) / months) : null,
    },
    assumptions,
  };
}

export function project(
  req: ProjectionRequest,
  state: LedgerState,
  persona: Persona,
  facts: FactsSnapshot,
  today: string,
): ProjectionResponse {
  const days = horizonDays(today, req.amount, req.unit);
  const opts: ProjectionOptions = { days, iraReturnPercent: req.iraReturnPercent ?? 0, savingsApyPercent: req.savingsApyPercent ?? 0 };
  const current = projectOne("current", state, persona, facts, today, opts);
  const coach = req.compare ? projectOne("coach", state, persona, facts, today, opts) : null;
  const earlier =
    coach && current.summary.cardPaidOffDate && coach.summary.cardPaidOffDate
      ? daysBetween(coach.summary.cardPaidOffDate, current.summary.cardPaidOffDate)
      : null;
  return {
    schemaVersion: 1,
    asOf: facts.asOf,
    startDate: today,
    endDate: addDays(today, days - 1),
    days,
    current,
    coach,
    difference: coach
      ? {
          netWorth: r2(coach.summary.endNetWorth - current.summary.endNetWorth),
          interestPaid: r2(coach.summary.interestPaid - current.summary.interestPaid),
          cardPaidOffDaysEarlier: earlier,
        }
      : null,
  };
}
