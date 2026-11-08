import type { FactsSnapshot, Persona, Projection, ProjectionPoint, ProjectionRequest, ProjectionResponse } from "../../../contracts/src";
import { THRESHOLDS } from "../data/config";
import { addDays, billDueOn, daysBetween, isPayday, lastDayOfMonth, r2 } from "./calendar";
import type { LedgerState } from "./ledger";
import { monthlyEssentials } from "./facts";
import { planV1 } from "./optimizer";
import { fitSpendModel, hashSeed, makeDaySampler, mulberry32, type Recurring, type SpendModel } from "./spending";

/**
 * How much room the Coach's sweep leaves for random spending, in standard deviations of a month of everyday spending.
 * With no room (0) the simulated plan overdrew checking in 66% of 5-year futures against 29% for doing nothing. Two
 * standard deviations (about $530) brings that to 31% for about $70 of final net worth and a one-month-later card payoff;
 * more room bought almost nothing. See docs/finance.md.
 */
export const POLICY = { bufferZ: 2 };

export interface ProjectionOptions {
  days: number;
  /** Extra dollars the Coach's sweep leaves in checking, on top of a month of bills and the cushion. */
  bufferMargin?: number;
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

interface PathResult {
  points: ProjectionPoint[];
  /** Net worth at each sampled day (filled in light mode, where no point objects are built). */
  nw: number[];
  lowest: { date: string; balance: number };
  firstNegativeDate: string | null;
  cardPaidOffDate: string | null;
  carLoanPaidOffDate: string | null;
  interest: number;
  end: Balances;
}

interface CalDay {
  date: string;
  weekday: number;
  payday: boolean;
  bills: { id: string; amount: number }[];
  oneOff: number;
  recurring: number;
  monthEnd: boolean;
}

/** Everything about each day that does not depend on the random spending, worked out once per request. */
function buildCalendar(state: LedgerState, persona: Persona, today: string, days: number, recurring: Recurring[]): CalDay[] {
  const out: CalDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    out.push({
      date,
      weekday: new Date(date + "T00:00:00Z").getUTCDay(),
      payday: isPayday(state.lastPaid, persona.income.everyDays, date),
      bills: persona.recurringBills.filter((b) => billDueOn(b.dayOfMonth, date)).map((b) => ({ id: b.id, amount: b.amount })),
      oneOff: state.oneOffBills.filter((b) => !b.paid && b.dueDate === date).reduce((s, b) => s + b.amount, 0),
      recurring: recurring.filter((r) => recurringDue(r, date)).reduce((s, r) => s + r.amount, 0),
      monthEnd: date.slice(8, 10) === String(lastDayOfMonth(date)).padStart(2, "0"),
    });
  }
  return out;
}

const recurringDue = (r: Recurring, date: string): boolean => {
  if (date < r.nextDate) return false;
  if (r.everyDays === 30) return billDueOn(Number(r.nextDate.slice(8, 10)), date);
  return daysBetween(r.nextDate, date) % r.everyDays === 0;
};

/**
 * One walk through the window. Day by day, in the forecast's own order: paycheck, bills (with interest and payoff on
 * the card and car loan), recurring payments found in history, then everyday spending, whatever `spend` says it is.
 * At each month end savings and the IRA grow if asked to, and the Coach's plan, if chosen, sweeps checking's surplus.
 */
function runPath(
  strategy: "current" | "coach",
  state: LedgerState,
  persona: Persona,
  facts: FactsSnapshot,
  today: string,
  opts: ProjectionOptions,
  spend: (day: CalDay) => number,
  cal: CalDay[],
  light: boolean,
): PathResult {
  const a = persona.accounts;
  const bal: Balances = { checking: state.balances.checking, savings: state.balances.savings, ira: state.balances.ira, card: state.balances.card, carLoan: state.balances.car_loan };
  const cushion = THRESHOLDS.cushion;
  const buffer = r2(persona.recurringBills.reduce((s, b) => s + b.amount, 0) + cushion + (opts.bufferMargin ?? 0));

  const goals = persona.goals.map((g) => ({ ...g }));
  let unclaimedMatch = a.ira.unclaimedMatchThisYear;
  const planFacts = strategy === "coach" ? structuredClone(facts) : facts;
  if (strategy === "coach") planFacts.shortfall = null;

  const stride = strideFor(opts.days);
  const points: ProjectionPoint[] = [];
  const nw: number[] = [];
  let lowest = { date: today, balance: Number.POSITIVE_INFINITY };
  let firstNegativeDate: string | null = null;
  let cardPaidOffDate: string | null = bal.card <= 0 ? today : null;
  let carLoanPaidOffDate: string | null = bal.carLoan <= 0 ? today : null;
  let interest = 0;

  for (let i = 0; i < opts.days; i++) {
    const day = cal[i]!;
    const date = day.date;

    if (day.payday) bal.checking += state.paycheckAmount;

    for (const b of day.bills) {
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
    bal.checking -= day.oneOff + day.recurring;
    bal.checking -= spend(day);

    if (day.monthEnd) {
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

    if ((i + 1) % stride === 0 || i === opts.days - 1) {
      if (light) nw.push(bal.checking + bal.savings + bal.ira - bal.card - bal.carLoan);
      else points.push(point(date, bal));
    }
  }
  return { points, nw, lowest, firstNegativeDate, cardPaidOffDate, carLoanPaidOffDate, interest, end: { ...bal } };
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;

export interface ProjectionModelChoice {
  kind: "learned" | "simple";
  model: SpendModel | null;
  runs: number;
  seed: string;
}

function projectOne(
  strategy: "current" | "coach",
  state: LedgerState,
  persona: Persona,
  facts: FactsSnapshot,
  today: string,
  opts: ProjectionOptions,
  choice: ProjectionModelChoice,
): Projection {
  const a = persona.accounts;
  const start = point(today, { checking: state.balances.checking, savings: state.balances.savings, ira: state.balances.ira, card: state.balances.card, carLoan: state.balances.car_loan });
  const monthlyBills = persona.recurringBills.reduce((s, b) => s + b.amount, 0);
  const essentials = monthlyEssentials(persona);
  const learned = choice.kind === "learned" && choice.model !== null;
  const flat = persona.spending.averageDailyDiscretionary;
  const mean = learned ? choice.model!.level.mean : flat;
  const recurring = learned ? choice.model!.recurring : [];

  if (strategy === "coach" && learned) opts = { ...opts, bufferMargin: POLICY.bufferZ * choice.model!.level.sd * Math.sqrt(30) };
  const cal = buildCalendar(state, persona, today, opts.days, recurring);
  // The expected path: spending at its learned level every day.
  const path = runPath(strategy, state, persona, facts, today, opts, () => mean, cal, false);

  // Simulated futures: the same random spending days for both strategies (seeded by run), so the two are comparable.
  let uncertainty: Projection["uncertainty"] = null;
  if (learned && choice.runs > 0) {
    const model = choice.model!;
    const n = path.points.length;
    const cols: number[][] = Array.from({ length: n }, () => []);
    const finals: number[] = [];
    let negative = 0,
      cardGone = 0;
    for (let r = 0; r < choice.runs; r++) {
      const sampler = makeDaySampler(model, mulberry32(hashSeed(`${choice.seed}:${r}`)));
      const res = runPath(strategy, state, persona, facts, today, opts, (day) => sampler(day.date, day.weekday), cal, true);
      res.nw.forEach((v, k) => cols[k]!.push(v));
      finals.push(res.nw[res.nw.length - 1]!);
      if (res.firstNegativeDate) negative++;
      if (res.end.card < 0.005) cardGone++;
    }
    const sorted = cols.map((c) => c.slice().sort((x, y) => x - y));
    finals.sort((x, y) => x - y);
    uncertainty = {
      runs: choice.runs,
      p10: sorted.map((c) => r2(pct(c, 0.1))),
      p50: sorted.map((c) => r2(pct(c, 0.5))),
      p90: sorted.map((c) => r2(pct(c, 0.9))),
      endNetWorth: { p10: r2(pct(finals, 0.1)), p50: r2(pct(finals, 0.5)), p90: r2(pct(finals, 0.9)) },
      probCheckingNegative: r2(negative / choice.runs),
      probCardPaidOffByEnd: r2(cardGone / choice.runs),
    };
  }

  const end = path.points[path.points.length - 1]!;
  const months = opts.days / 30.4375;
  const rent = persona.recurringBills.find((b) => b.id === "rent");
  const m = choice.model;
  const assumptions = [
    `Paychecks of ${usd(state.paycheckAmount)} arrive every ${persona.income.everyDays} days and never change. No raises.`,
    `Bills repeat every month as they are today (${usd(monthlyBills)} a month, rent ${usd(rent?.amount ?? 0)} included).`,
    learned && m
      ? m.basis === "history"
        ? `Everyday spending is learned from your last ${m.level.daysObserved} days: about ${usd(m.level.mean)} a day (your profile says ${usd(flat)}). It moves only as far as the evidence does. Single days vary a lot, by about ${usd(m.level.sd)}.`
        : `Everyday spending is assumed at ${usd(flat)} a day, with single days varying by about ${usd(m.level.sd)}. It will adjust as your own spending history builds.`
      : `Everyday spending stays at ${usd(flat)} a day, paid from checking.`,
    ...(learned && m ? m.recurring.map((r) => `Found a payment that repeats: ${r.label}, ${usd(r.amount)} ${r.everyDays === 30 ? "a month" : r.everyDays === 14 ? "every two weeks" : "a week"} (seen ${r.seen} times). It is included.`) : []),
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
    const margin = opts.bufferMargin ?? 0;
    const buffer = r2(monthlyBills + THRESHOLDS.cushion + margin);
    assumptions.push(
      `At each month end, money in checking above ${usd(buffer)} (a month of bills, the ${usd(THRESHOLDS.cushion)} cushion${margin > 0 ? ` and about ${usd(margin)} of room for random spending` : ""}) is sent by the Coach's plan: employer match, then the card, then the emergency fund, goals, and the rest.`,
    );
  }
  if (uncertainty) {
    assumptions.push(
      `The shaded range is the middle 80% of ${uncertainty.runs} simulated futures. In each, spending days are drawn from your own history, the true spending level may be a bit off the estimate, and habits drift a few percent a month. It assumes your habits stay roughly steady: a sudden change takes a few weeks to show.`,
    );
  }

  return {
    strategy,
    start,
    points: path.points,
    summary: {
      startNetWorth: start.netWorth,
      endNetWorth: end.netWorth,
      change: r2(end.netWorth - start.netWorth),
      lowestChecking: path.lowest,
      firstNegativeDate: path.firstNegativeDate,
      cardPaidOffDate: path.cardPaidOffDate === today && state.balances.card > 0 ? null : path.cardPaidOffDate,
      carLoanPaidOffDate: path.carLoanPaidOffDate === today && state.balances.car_loan > 0 ? null : path.carLoanPaidOffDate,
      interestPaid: r2(path.interest),
      emergencyFundMonthsEnd: r2(end.savings / essentials),
      avgMonthlyChangeInChecking: strategy === "current" ? r2((end.checking - start.checking) / months) : null,
    },
    assumptions,
    model:
      learned && m
        ? {
            kind: "learned",
            dailySpendMean: r2(m.level.mean),
            dailySpendSd: r2(m.level.sd),
            basis: m.basis,
            daysObserved: m.level.daysObserved,
            weightOnHistory: m.level.weightOnData,
            detectedRecurring: m.recurring.map((r) => ({ label: r.label, amount: r.amount, everyDays: r.everyDays, nextDate: r.nextDate, seen: r.seen })),
          }
        : { kind: "simple", dailySpendMean: flat, dailySpendSd: 0, basis: "profile", daysObserved: 0, weightOnHistory: 0, detectedRecurring: [] },
    uncertainty,
  };
}

export const DEFAULT_RUNS = 300;

export function project(
  req: ProjectionRequest,
  state: LedgerState,
  persona: Persona,
  facts: FactsSnapshot,
  today: string,
): ProjectionResponse {
  const days = horizonDays(today, req.amount, req.unit);
  const opts: ProjectionOptions = { days, iraReturnPercent: req.iraReturnPercent ?? 0, savingsApyPercent: req.savingsApyPercent ?? 0 };
  const kind = req.model ?? "learned";
  const model = kind === "learned" ? fitSpendModel(state, persona, today) : null;
  const choice: ProjectionModelChoice = { kind, model, runs: kind === "learned" ? req.runs ?? DEFAULT_RUNS : 0, seed: `${today}|${days}|${model ? model.level.mean : 0}` };
  const current = projectOne("current", state, persona, facts, today, opts, choice);
  const coach = req.compare ? projectOne("coach", state, persona, facts, today, opts, choice) : null;
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
