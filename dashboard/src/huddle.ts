/**
 * The Huddle: the user's accounts as a group of people, with one plain-English line each,
 * all computed from P1's facts snapshot (no LLM, so every number is exact).
 *
 * Also: "try a decision" — each person says what a choice would do to them, before → after.
 * Purchases and losing income go through P1's what-if engine; moving money is simple arithmetic
 * on the same snapshot (what-if does not model transfers).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

type Status = "good" | "watch" | "concern";
export type Mood = "happy" | "okay" | "worried";
const moodOf: Record<Status, Mood> = { good: "happy", watch: "okay", concern: "worried" };

export type Person = {
  id: string;
  name: string;
  emoji: string;
  group: "have" | "owe" | "coach";
  balance: number;
  status: Status;
  mood: Mood;
  /** One short line, in their voice, with real numbers. */
  says: string;
  /** Detail rows for the tap-to-open sheet. */
  detail: { label: string; value: string; note?: string }[];
  upcoming: { date: string; label: string; amount: number; sign: "+" | "-" }[];
};

export type Huddle = {
  firstName: string;
  asOf: string;
  localDate: string;
  netWorth: number;
  have: number;
  owe: number;
  people: Person[];
  coach: Person & { counts: Record<Status, number>; bestMove: string };
  timeline: {
    days: { date: string; balance: number }[];
    cushion: number;
    marks: { date: string; label: string; amount: number; who: string; sign: "+" | "-" }[];
  };
};

// ---------- formatting ----------
export const money = (n: number) => {
  const neg = n < 0;
  const a = Math.abs(n);
  const s = a.toLocaleString("en-US", { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}$${s}`;
};
const roundMoney = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
const pct = (n: number) => `${Math.round(n)}%`;
const daysOfCover = (savings: number, monthlyEssentials: number) =>
  monthlyEssentials > 0 ? Math.floor((savings / monthlyEssentials) * 30) : 0;

/** Same rule as the contract: higher_is_better / lower_is_better against goodAt and concernAt. */
export function statusFor(ind: { direction: string; goodAt: number; concernAt: number }, value: number): Status {
  if (ind.direction === "higher_is_better") return value >= ind.goodAt ? "good" : value < ind.concernAt ? "concern" : "watch";
  return value < ind.goodAt ? "good" : value >= ind.concernAt ? "concern" : "watch";
}

const BILL_OWNER: Record<string, string> = { car_loan: "car_loan", card_minimum: "card" };

function castInfo(cast: any[], id: string) {
  const c = cast.find((x) => x.id === id);
  return { name: c?.name ?? id, emoji: c?.emoji ?? "•" };
}

// ---------- the huddle ----------
export function buildHuddle(facts: any, cast: any[]): Huddle {
  const acct = (id: string) => facts.accounts.find((a: any) => a.id === id);
  const ind = (id: string) => facts.indicators.find((i: any) => i.id === id);
  const f = facts.forecast;
  const bills: any[] = facts.upcomingBills ?? [];
  const pays: any[] = facts.upcomingPaychecks ?? [];
  const people: Person[] = [];
  const base = (id: string, group: Person["group"]) => ({ id, group, ...castInfo(cast, id) });

  // Checking: the next few weeks. "Room" is what can be spent without dipping below the cushion
  // at ANY point in the 45-day forecast (not only before payday: rent can land right after it).
  const ch = acct("checking");
  if (ch) {
    const room = roomToSpend(f);
    const dipBill = billBehindDip(f, bills);
    const status: Status = f.firstNegativeDate ? "concern" : f.firstBelowCushionDate || f.lowest.balance < f.cushion * 2 ? "watch" : "good";
    const says = facts.shortfall
      ? `I'll be ${money(facts.shortfall.amount)} short on ${day(facts.shortfall.firstNegativeDate)}. Payday is ${day(f.nextPayday)}.`
      : f.firstNegativeDate
        ? `I go below $0 on ${day(f.firstNegativeDate)}. My lowest is ${money(f.lowest.balance)} on ${day(f.lowest.date)}.`
        : room < f.safeToSpendUntilPayday && dipBill
          ? `${dipBill.label} on ${day(dipBill.dueDate)} drops me to ${money(f.lowest.balance)}. Keep extra spending under ${money(room)} for now.`
          : `After your bills, you can safely spend ${money(room)} before payday on ${day(f.nextPayday)}.`;
    people.push({
      ...base("checking", "have"),
      balance: ch.balance,
      status,
      mood: moodOf[status],
      says,
      detail: [
        { label: "Balance now", value: money(ch.balance) },
        { label: "Safe to spend now", value: money(room), note: `keeps a ${money(f.cushion)} cushion through ${day(f.endDate)}` },
        { label: "Lowest point (next 45 days)", value: `${money(f.lowest.balance)} on ${day(f.lowest.date)}` },
        { label: "Next payday", value: day(f.nextPayday) },
        { label: "Bills paid on time in a row", value: String(ind("bill_reliability")?.value ?? "—") },
      ],
      upcoming: [
        ...pays.map((p) => ({ date: p.date, label: "Paycheck", amount: p.amount, sign: "+" as const })),
        ...bills.filter((b) => !BILL_OWNER[b.id]).map((b) => ({ date: b.dueDate, label: b.label, amount: b.amount, sign: "-" as const })),
      ].sort((a, b) => a.date.localeCompare(b.date)),
    });
  }

  // Savings: months of runway.
  const sv = acct("savings");
  const runway = ind("runway");
  if (sv && runway) {
    const ess = runway.inputs.monthlyEssentials ?? 0;
    const goal = roundMoney(ess * runway.goodAt);
    const days = daysOfCover(sv.balance, ess);
    people.push({
      ...base("savings", "have"),
      balance: sv.balance,
      status: runway.status,
      mood: moodOf[runway.status as Status],
      says:
        runway.status === "good"
          ? `I could cover your must-pay bills for ${runway.value} months. That's a solid safety net.`
          : `I'd cover your must-pay bills for about ${days} days. The goal is ${runway.goodAt} months (${money(goal)}).`,
      detail: [
        { label: "Balance now", value: money(sv.balance) },
        { label: "Covers must-pay bills for", value: `${runway.value} months`, note: `about ${days} days` },
        { label: "Must-pay bills per month", value: money(ess) },
        { label: `Goal (${runway.goodAt} months)`, value: money(goal), note: `${money(Math.max(0, goal - sv.balance))} to go` },
        ...(ind("savings_rate") ? [{ label: "Share of income you kept (30 days)", value: pct(ind("savings_rate").value) }] : []),
      ],
      upcoming: [],
    });
  }

  // IRA: retirement progress and free match money.
  const ira = acct("ira");
  const ret = ind("retirement_on_track");
  if (ira && ret) {
    const missing = ira.unclaimedMatchThisYear ?? 0;
    const says =
      missing > 0 && (ira.userContributionPercent ?? 0) < (ira.employerMatchPercent ?? 0)
        ? `Your job matches ${ira.employerMatchPercent}% but you put in ${ira.userContributionPercent}%. That's ${money(missing)} of free money left this year.`
        : `I'm at ${pct(ret.value)} of your ${money(ira.retirementTarget ?? ret.inputs.target)} goal for your age.`;
    people.push({
      ...base("ira", "have"),
      balance: ira.balance,
      status: ret.status,
      mood: moodOf[ret.status as Status],
      says,
      detail: [
        { label: "Balance now", value: money(ira.balance) },
        { label: "On track for your age", value: pct(ret.value), note: `goal ${money(ira.retirementTarget ?? ret.inputs.target)}` },
        ...(ira.employerMatchPercent != null
          ? [{ label: "Your job matches up to", value: `${ira.employerMatchPercent}%`, note: `you put in ${ira.userContributionPercent ?? 0}%` }]
          : []),
        ...(missing > 0 ? [{ label: "Free match not claimed this year", value: money(missing) }] : []),
        ...(ira.daysSinceLastContribution != null ? [{ label: "Days since last contribution", value: String(ira.daysSinceLastContribution) }] : []),
      ],
      upcoming: [],
    });
  }

  // Card: utilization and interest.
  const card = acct("card");
  const util = ind("credit_utilization");
  if (card && util) {
    const interest = roundMoney((card.balance * (card.aprPercent ?? 0)) / 1200);
    const bill = bills.find((b) => b.id === "card_minimum");
    people.push({
      ...base("card", "owe"),
      balance: card.balance,
      status: util.status,
      mood: moodOf[util.status as Status],
      says:
        util.status === "good"
          ? `You owe ${money(card.balance)}, ${pct(util.value)} of your limit. That's healthy.`
          : `You owe ${money(card.balance)}, ${pct(util.value)} of your limit. Under ${util.goodAt}% is healthier. I cost about ${money(interest)} a month in interest.`,
      detail: [
        { label: "You owe", value: money(card.balance) },
        { label: "Limit used", value: pct(util.value), note: `under ${util.goodAt}% is healthier` },
        { label: "Limit", value: money(card.limit ?? util.inputs.cardLimit) },
        { label: "Interest rate", value: `${card.aprPercent}%`, note: `about ${money(interest)} a month` },
        ...(card.minimumPayment != null ? [{ label: "Minimum payment", value: money(card.minimumPayment) }] : []),
      ],
      upcoming: bill ? [{ date: bill.dueDate, label: bill.label, amount: bill.amount, sign: "-" }] : [],
    });
  }

  // Car loan: the steady one. Worried only if Checking runs out before its payment.
  const car = acct("car_loan");
  if (car) {
    const bill = bills.find((b) => b.id === "car_loan");
    const atRisk = !!(bill && f.firstNegativeDate && f.firstNegativeDate <= bill.dueDate);
    const status: Status = atRisk ? "concern" : "good";
    const cheaper = card && (car.aprPercent ?? 0) < (card.aprPercent ?? 0);
    people.push({
      ...base("car_loan", "owe"),
      balance: car.balance,
      status,
      mood: moodOf[status],
      says: atRisk
        ? `My ${money(bill!.amount)} payment is due ${day(bill!.dueDate)}, but Checking runs short before then.`
        : `You owe ${money(car.balance)}. ${bill ? `${money(bill.amount)} is due ${day(bill.dueDate)}. ` : ""}${cheaper ? "My rate is lower than the card's, so on-time payments are enough." : ""}`.trim(),
      detail: [
        { label: "You owe", value: money(car.balance) },
        { label: "Interest rate", value: `${car.aprPercent}%` },
        ...(car.monthlyPayment != null ? [{ label: "Monthly payment", value: money(car.monthlyPayment) }] : []),
        ...(bill ? [{ label: "Next payment", value: `${money(bill.amount)} on ${day(bill.dueDate)}` }] : []),
      ],
      upcoming: bill ? [{ date: bill.dueDate, label: bill.label, amount: bill.amount, sign: "-" }] : [],
    });
  }

  // Coach: the whole picture and one next move.
  const counts: Record<Status, number> = { good: 0, watch: 0, concern: 0 };
  for (const p of people) counts[p.status]++;
  const have = roundMoney(people.filter((p) => p.group === "have").reduce((s, p) => s + p.balance, 0));
  const owe = roundMoney(people.filter((p) => p.group === "owe").reduce((s, p) => s + p.balance, 0));
  const bestMove = pickBestMove(facts, people);
  const overall: Status = counts.concern ? "concern" : counts.watch ? "watch" : "good";
  const coach = {
    ...base("coach", "coach"),
    balance: roundMoney(have - owe),
    status: overall,
    // Coach stays calm: worried only when a bill is about to bounce.
    mood: (facts.shortfall ? "worried" : overall === "good" ? "happy" : "okay") as Mood,
    says: bestMove,
    counts,
    bestMove,
    detail: [
      { label: "You have", value: money(have), note: "Checking + Savings + IRA" },
      { label: "You owe", value: money(owe), note: "Card + Car Loan" },
      { label: "Net worth", value: money(roundMoney(have - owe)) },
    ],
    upcoming: [],
  };

  const who = (billId: string) => BILL_OWNER[billId] ?? "checking";
  return {
    firstName: facts.customer?.firstName ?? "",
    asOf: facts.asOf,
    localDate: facts.localDate,
    netWorth: roundMoney(have - owe),
    have,
    owe,
    people,
    coach,
    timeline: {
      days: f.days.slice(0, 42),
      cushion: f.cushion,
      marks: [
        ...pays.map((p) => ({ date: p.date, label: "Paycheck", amount: p.amount, who: "checking", sign: "+" as const })),
        ...bills.map((b) => ({ date: b.dueDate, label: b.label, amount: b.amount, who: who(b.id), sign: "-" as const })),
      ]
        .filter((m) => m.date <= (f.days[41]?.date ?? f.endDate))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

/** Spendable today without the forecast ever dipping below the cushion. */
export function roomToSpend(f: any): number {
  return Math.max(0, roundMoney(Math.min(f.safeToSpendUntilPayday, f.lowest.balance - f.cushion)));
}

/** The biggest bill due in the week before the lowest day: usually what causes the dip. */
function billBehindDip(f: any, bills: any[]) {
  const low = f.lowest.date;
  const weekBefore = new Date(Date.parse(low) - 7 * 86400000).toISOString().slice(0, 10);
  return bills.filter((b) => b.dueDate <= low && b.dueDate >= weekBefore).sort((a, b) => b.amount - a.amount)[0];
}

/** The one thing to do first, in order of urgency. A suggestion only: nothing moves money. */
function pickBestMove(facts: any, people: Person[]): string {
  const s = facts.shortfall;
  if (s) return `First: move ${money(s.suggestedTransfer)} from Savings to Checking before ${day(s.firstNegativeDate)} so no bill bounces.`;
  const ira = facts.accounts.find((a: any) => a.id === "ira");
  if (ira?.unclaimedMatchThisYear > 0 && (ira.userContributionPercent ?? 0) < (ira.employerMatchPercent ?? 0))
    return `Easiest win: raise your IRA contribution to ${ira.employerMatchPercent}% to get the ${money(ira.unclaimedMatchThisYear)} match your job offers.`;
  const card = people.find((p) => p.id === "card");
  if (card && card.status !== "good") return `Next: pay down the card. It charges the highest interest of anything you owe.`;
  const sv = people.find((p) => p.id === "savings");
  if (sv && sv.status !== "good") return `Next: grow Savings a little each payday until it covers 3 months of bills.`;
  return `You're in good shape. Keep paying bills on time.`;
}

// ---------- try a decision ----------
// The AI (or the quick buttons) only pick WHICH decision this is. Every number below comes from code:
// P1's what-if engine when it models the case, otherwise simple arithmetic on the same snapshot.
export type Decision =
  | { kind: "buy"; amount: number; label?: string } // spend from Checking today
  | { kind: "monthly"; amount: number; label?: string; dayOfMonth?: number } // new monthly bill
  | { kind: "later_expense"; amount: number; date: string; label?: string } // one-time cost on a future date
  | { kind: "save"; amount: number } // Checking -> Savings
  | { kind: "from_savings"; amount: number } // Savings -> Checking
  | { kind: "pay_card"; amount: number } // Checking -> Card
  | { kind: "pay_car"; amount: number } // Checking -> Car Loan
  | { kind: "ira"; amount: number } // Checking -> IRA
  | { kind: "lose_income"; months: number };

export const DECISION_KINDS = ["buy", "monthly", "later_expense", "save", "from_savings", "pay_card", "pay_car", "ira", "lose_income"] as const;

export type Reaction = { id: string; mood: Mood; text: string; before?: string; after?: string; changed: boolean };
export type DecisionResult = { title: string; verdict: string; safe: boolean; reactions: Reaction[]; source: "what_if" | "math" };

const cleanLabel = (x: unknown) =>
  typeof x === "string" ? x.replace(/[^\p{L}\p{N} '&.,-]/gu, "").trim().slice(0, 40) || undefined : undefined;

export function parseDecision(body: any): Decision | null {
  const kind = body?.kind;
  if (kind === "lose_income") {
    const m = Math.round(Number(body.months));
    return m >= 1 && m <= 12 ? { kind, months: m } : null;
  }
  const amount = roundMoney(Number(String(body?.amount ?? "").replace(/[$,]/g, "")));
  if (!DECISION_KINDS.includes(kind) || !(amount > 0) || amount > 1_000_000) return null;
  const label = cleanLabel(body.label);
  if (kind === "buy") return { kind, amount, label };
  if (kind === "monthly") {
    const dom = Math.round(Number(body.dayOfMonth));
    return { kind, amount, label: label ?? "new bill", dayOfMonth: dom >= 1 && dom <= 28 ? dom : undefined };
  }
  if (kind === "later_expense") {
    if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return null;
    return { kind, amount, date: body.date, label: label ?? "expense" };
  }
  return { kind, amount } as Decision;
}

/** What a decision does to Checking's balance on each forecast day (negative = less money). */
function checkingDeltas(f: any, d: Decision): number[] {
  const days: { date: string }[] = f.days;
  if (d.kind === "lose_income" ) return days.map(() => 0); // handled by what-if
  if (d.kind === "monthly") {
    const dom = d.dayOfMonth ?? Number(f.startDate.slice(8, 10));
    let total = 0;
    return days.map((x) => (Number(x.date.slice(8, 10)) === dom ? (total -= d.amount) : total));
  }
  if (d.kind === "later_expense") return days.map((x) => (x.date >= d.date ? -d.amount : 0));
  const sign = d.kind === "from_savings" ? 1 : -1;
  return days.map(() => sign * d.amount);
}

type WhatIf = (scenario: unknown) => Promise<any>;

export async function decide(facts: any, d: Decision, whatIf: WhatIf): Promise<DecisionResult> {
  const f = facts.forecast;
  const acct = (id: string) => facts.accounts.find((a: any) => a.id === id);
  const ind = (id: string) => facts.indicators.find((i: any) => i.id === id);
  const runway = ind("runway");
  const ess = runway?.inputs.monthlyEssentials ?? 0;
  const goalMonths = runway?.goodAt ?? 3;
  const sv = acct("savings")?.balance ?? 0;
  const same = (id: string, text = "No change for me."): Reaction => ({ id, mood: "okay", text, changed: false });
  const carBill = facts.upcomingBills.find((b: any) => b.id === "car_loan");

  if (d.kind === "lose_income") {
    const r = await whatIf({ type: "lose_income", months: d.months }).catch(() => null);
    const neg = r?.after?.firstNegativeDate ?? null;
    const low = r?.after?.lowestBalance;
    const days = daysOfCover(sv, ess);
    return {
      title: `If your paycheck stopped for ${d.months} month${d.months > 1 ? "s" : ""}`,
      safe: false,
      verdict: `Savings would carry your must-pay bills for about ${days} days. A ${goalMonths}-month cushion would be ${money(roundMoney(ess * goalMonths))}.`,
      source: r ? "what_if" : "math",
      reactions: [
        {
          id: "checking",
          mood: neg ? "worried" : "okay",
          text: neg ? `I'd run out on ${day(neg)}.` : `I'd get tight, but stay above $0 for the next 45 days.`,
          before: `lowest ${money(f.lowest.balance)}`,
          after: low ? `lowest ${money(low.balance)}` : undefined,
          changed: true,
        },
        { id: "savings", mood: "worried", text: `I'd be next. I can cover about ${days} days of must-pay bills.`, changed: true },
        { id: "ira", mood: "okay", text: "Leave me alone if you can. Early withdrawals cost penalties.", changed: false },
        { id: "card", mood: "okay", text: `Try not to lean on me. ${acct("card")?.aprPercent ?? 0}% interest adds up fast.`, changed: false },
        { id: "car_loan", mood: neg ? "worried" : "okay", text: neg ? "My payment would be at risk." : "My payment would still go through.", changed: !!neg },
      ],
    };
  }

  // Checking after the decision: arithmetic on the forecast, replaced by P1's what-if where it models the case.
  if (d.kind === "later_expense" && d.date > f.endDate) {
    const paydays = Math.max(1, Math.ceil((Date.parse(d.date) - Date.parse(f.startDate)) / (14 * 86400000)));
    return {
      title: `If ${d.label ?? "it"} costs ${money(d.amount)} on ${day(d.date)}`,
      verdict: `That's past the next 6 weeks. To be ready, set aside about ${money(roundMoney(d.amount / paydays))} from each paycheck until then.`,
      safe: true,
      source: "math",
      reactions: [{ id: "savings", mood: "happy", text: `Park it with me as you go, so it's ready on ${day(d.date)}.`, changed: true }],
    };
  }
  if (d.kind === "later_expense" && d.date < f.startDate) d = { kind: "buy", amount: d.amount, label: d.label };
  const deltas = checkingDeltas(f, d);
  const after = f.days.map((x: any, i: number) => ({ date: x.date, balance: roundMoney(x.balance + deltas[i]) }));
  let low = after.reduce((m: any, x: any) => (x.balance < m.balance ? x : m), after[0]);
  let neg: string | null = after.find((x: any) => x.balance < 0)?.date ?? null;
  let source: DecisionResult["source"] = "math";
  const scenario =
    d.kind === "buy" ? { type: "purchase_now", amount: d.amount, label: d.label }
    : d.kind === "monthly" ? { type: "new_recurring", amount: d.amount, dayOfMonth: d.dayOfMonth ?? Math.min(28, Number(f.startDate.slice(8, 10))), label: d.label ?? "new bill" }
    : d.kind === "later_expense" ? { type: "one_time_expense", amount: d.amount, date: d.date, label: d.label }
    : null;
  if (scenario) {
    const r = await whatIf(scenario).catch(() => null);
    if (r?.after?.lowestBalance) {
      source = "what_if";
      low = r.after.lowestBalance;
      neg = r.after.firstNegativeDate;
    }
  }
  const room = roomToSpend(f);
  const gains = d.kind === "from_savings";
  const safe = !neg && roundMoney(low.balance - f.cushion) >= 0;
  const negBill = neg ? facts.upcomingBills.find((b: any) => b.dueDate === neg) : null;
  const spare = `Checking can spare about ${money(room)} right now.`;

  const reactions: Record<string, Reaction> = Object.fromEntries(["savings", "ira", "card", "car_loan"].map((id) => [id, same(id)]));
  reactions.checking = {
    id: "checking",
    mood: neg ? "worried" : safe ? "happy" : "okay",
    text: neg
      ? `That puts me below $0 on ${day(neg)}${negBill ? `, when ${negBill.label.toLowerCase()} is due` : ""}.`
      : gains
        ? `Thanks. My lowest point goes up to ${money(low.balance)}.`
        : safe
          ? `Fine by me. I'd still stay above my ${money(f.cushion)} cushion.`
          : `Tight: my lowest would be ${money(low.balance)}, under my ${money(f.cushion)} cushion.`,
    before: `lowest ${money(f.lowest.balance)}`,
    after: `lowest ${money(low.balance)}`,
    changed: true,
  };
  if (neg && carBill && neg <= carBill.dueDate)
    reactions.car_loan = { id: "car_loan", mood: "worried", text: `My ${money(carBill.amount)} payment on ${day(carBill.dueDate)} could bounce.`, changed: true };

  const fromChecking = (good: string) =>
    neg ? `Not right now. It would leave Checking below $0 on ${day(neg)}. ${spare}` : safe ? good : `Smaller is safer. ${spare}`;
  const savingsTo = (newBal: number): Reaction => {
    const newRunway = ess > 0 ? newBal / ess : 0;
    const st = runway ? statusFor(runway, Math.round(newRunway * 100) / 100) : "watch";
    const a = daysOfCover(sv, ess), b = daysOfCover(newBal, ess);
    return {
      id: "savings",
      mood: moodOf[st],
      text: a !== b ? `I'd cover about ${b} days of must-pay bills instead of ${a}.` : `Every bit counts. The goal is ${money(roundMoney(ess * goalMonths))} (${goalMonths} months of bills).`,
      before: money(sv),
      after: money(roundMoney(newBal)),
      changed: true,
    };
  };

  let title = "";
  let verdict = "";
  switch (d.kind) {
    case "buy":
      title = `If you spend ${money(d.amount)}${d.label ? ` on ${d.label}` : ""} today`;
      verdict = fromChecking(`You can afford this. Checking stays above its cushion.`);
      if (neg) reactions.savings = same("savings", "If Checking runs short, you'd have to pull from me.");
      break;
    case "later_expense":
      title = `If ${d.label ?? "it"} costs ${money(d.amount)} on ${day(d.date)}`;
      verdict = neg
        ? `Plan ahead: Checking would go below $0 on ${day(neg)}. Set aside money from your next paycheck first.`
        : safe ? `You can cover this when it comes up.` : `Doable, but it eats into your cushion. Setting a little aside each payday would help.`;
      break;
    case "monthly": {
      title = `If you add ${d.label ?? "a new bill"} for ${money(d.amount)} a month`;
      const sr = ind("savings_rate");
      if (sr?.inputs.income30d) {
        const income = sr.inputs.income30d, spend = sr.inputs.spending30d;
        const nowPct = ((income - spend) / income) * 100, newPct = ((income - spend - d.amount) / income) * 100;
        reactions.savings = {
          id: "savings",
          mood: moodOf[statusFor(sr, newPct)],
          text: `You'd keep ${pct(newPct)} of your income instead of ${pct(nowPct)}. That's ${money(roundMoney(d.amount * 12))} a year.`,
          changed: true,
        };
      }
      verdict = neg
        ? `Not with today's budget. Checking would go below $0 on ${day(neg)}. Something else would need to go.`
        : safe ? `It fits, but it adds up to ${money(roundMoney(d.amount * 12))} a year.` : `It fits, barely. Checking dips under its cushion, so trim somewhere else first.`;
      break;
    }
    case "save":
      title = `If you move ${money(d.amount)} from Checking to Savings`;
      reactions.savings = savingsTo(sv + d.amount);
      verdict = fromChecking(`Good move. Your safety net grows and Checking can afford it.`);
      break;
    case "from_savings": {
      const amt = Math.min(d.amount, sv);
      title = `If you move ${money(amt)} from Savings to Checking`;
      reactions.savings = { ...savingsTo(sv - amt), mood: "worried" };
      verdict = f.firstNegativeDate
        ? `That would keep Checking from going below $0. Refill Savings when you can.`
        : `Checking doesn't need it right now. Keeping it in Savings protects you from surprises.`;
      break;
    }
    case "pay_card": {
      const card = acct("card");
      const util = ind("credit_utilization");
      const pay = Math.min(d.amount, card?.balance ?? d.amount);
      const newBal = roundMoney((card?.balance ?? 0) - pay);
      const newUtil = card?.limit ? (newBal / card.limit) * 100 : 0;
      const saved = roundMoney((pay * (card?.aprPercent ?? 0)) / 1200);
      reactions.card = {
        id: "card",
        mood: moodOf[util ? statusFor(util, newUtil) : "watch"],
        text: `Limit used drops from ${pct(util?.value ?? 0)} to ${pct(newUtil)}. You'd pay about ${money(saved)} less interest each month.`,
        before: money(card?.balance ?? 0),
        after: money(newBal),
        changed: true,
      };
      title = `If you pay ${money(pay)} extra on the card`;
      verdict = fromChecking(`Good move. The card has your highest interest rate, and Checking can afford it.`);
      break;
    }
    case "pay_car": {
      const car = acct("car_loan");
      const card = acct("card");
      const pay = Math.min(d.amount, car?.balance ?? d.amount);
      const saved = roundMoney((pay * (car?.aprPercent ?? 0)) / 1200);
      reactions.car_loan = {
        id: "car_loan",
        mood: neg ? "worried" : "happy",
        text: `You'd owe ${money(roundMoney((car?.balance ?? 0) - pay))}. That saves about ${money(saved)} a month in interest.`,
        before: money(car?.balance ?? 0),
        after: money(roundMoney((car?.balance ?? 0) - pay)),
        changed: true,
      };
      const cardFirst = card && card.balance > 0 && (card.aprPercent ?? 0) > (car?.aprPercent ?? 0);
      if (cardFirst)
        reactions.card = { id: "card", mood: "okay", text: `Paying me instead saves more: my rate is ${card.aprPercent}% vs ${car?.aprPercent}%.`, changed: true };
      title = `If you pay ${money(pay)} extra on the car loan`;
      verdict = fromChecking(cardFirst ? `It helps, but the same money on the card saves more interest.` : `Good move. Checking can afford it.`);
      break;
    }
    case "ira": {
      const ira = acct("ira");
      const ret = ind("retirement_on_track");
      const target = ira?.retirementTarget ?? ret?.inputs.target ?? 0;
      const newPct = target ? ((ira.balance + d.amount) / target) * 100 : 0;
      reactions.ira = {
        id: "ira",
        mood: ret ? moodOf[statusFor(ret, newPct)] : "okay",
        text: `I'd be at ${pct(newPct)} of your goal, up from ${pct(ret?.value ?? 0)}.${ira?.unclaimedMatchThisYear > 0 ? ` Raising your paycheck contribution also unlocks the ${money(ira.unclaimedMatchThisYear)} match.` : ""}`,
        before: money(ira?.balance ?? 0),
        after: money(roundMoney((ira?.balance ?? 0) + d.amount)),
        changed: true,
      };
      title = `If you put ${money(d.amount)} into your IRA`;
      verdict = fromChecking(`Good for later. Checking can afford it right now.`);
      break;
    }
  }

  return {
    title,
    verdict,
    safe: gains ? true : safe,
    source,
    reactions: ["checking", "savings", "ira", "card", "car_loan"].map((id) => reactions[id]).filter(Boolean),
  };
}

// ---------- understanding a typed question ----------
/** Words → a decision without AI. Used when Gemini is unavailable or unsure. */
export function guessDecision(text: string, today: string): Decision | null {
  const t = text.toLowerCase();
  const m = t.match(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/);
  const amount = m ? Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1) : NaN;
  const months = t.match(/(\d+)\s*months?/);
  if (/(lose|lost|quit|fired|laid off|no) .*(job|income|paycheck|pay)|without (a )?(job|income|paycheck)/.test(t))
    return { kind: "lose_income", months: months ? Math.min(12, Math.max(1, Number(months[1]))) : 1 };
  if (!(amount > 0)) return null;
  if (/from (my )?savings|out of (my )?savings|use (my )?savings/.test(t)) return { kind: "from_savings", amount };
  if (/ira|retire|401/.test(t)) return { kind: "ira", amount };
  if (/car (loan|payment)|auto loan/.test(t) && /pay|extra/.test(t)) return { kind: "pay_car", amount };
  if (/(credit )?card/.test(t) && /pay|extra|down/.test(t)) return { kind: "pay_card", amount };
  if (/(put|move|add|save|saving|transfer).*(savings|save)|^save/.test(t)) return { kind: "save", amount };
  if (/(a|per|every|each) ?month|monthly|\/ ?mo\b|subscription|membership/.test(t)) return { kind: "monthly", amount };
  return { kind: "buy", amount };
}

export function decisionPrompt(text: string, today: string): string {
  return `You turn a person's money question into ONE JSON object. Do not answer the question. Today is ${today}.
Pick the kind that fits best:
- buy: spending money now. {"kind":"buy","amount":number,"label":"short item name"}
- monthly: a new recurring monthly cost. {"kind":"monthly","amount":number per month,"label":"...","dayOfMonth":1-28 optional}
- later_expense: a one-time cost on a future date. {"kind":"later_expense","amount":number,"date":"YYYY-MM-DD","label":"..."}
- save: move money from checking into savings. {"kind":"save","amount":number}
- from_savings: move money from savings into checking. {"kind":"from_savings","amount":number}
- pay_card: pay extra on the credit card. {"kind":"pay_card","amount":number}
- pay_car: pay extra on the car loan. {"kind":"pay_car","amount":number}
- ira: put money into the IRA / retirement. {"kind":"ira","amount":number}
- lose_income: losing a job or paycheck. {"kind":"lose_income","months":1-12}
- unknown: anything else, or no amount given. {"kind":"unknown"}
Amounts are US dollars as plain numbers ("1.2k" = 1200). Labels are 1-4 plain words. Reply with JSON only.
Question: ${JSON.stringify(text.slice(0, 300))}`;
}

/** Understand a typed what-if. The AI only classifies; all numbers are computed afterwards. */
export async function understand(
  text: string,
  today: string,
  ask: ((prompt: string) => Promise<string>) | null,
): Promise<{ decision: Decision | null; by: "ai" | "rules" }> {
  if (ask) {
    try {
      const raw = await ask(decisionPrompt(text, today));
      const json = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
      if (json?.kind === "unknown") return { decision: guessDecision(text, today), by: "rules" };
      const d = parseDecision(json);
      if (d) return { decision: d, by: "ai" };
    } catch {
      /* fall through to the rules */
    }
  }
  return { decision: guessDecision(text, today), by: "rules" };
}

// ---------- private links ----------
/** A link to one person's huddle. Expires (default 24 hours); opening it still needs a code texted to that phone. */
export function signLink(secret: string, phone: string, ttlSeconds = 86400, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ p: phone, i: iat, e: iat + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`huddle:${payload}`).digest("base64url").slice(0, 32);
  return `${payload}.${sig}`;
}

export function verifyLink(secret: string, token: string, nowMs = Date.now()): { phone: string; issuedAt: number } | null {
  if (!secret || typeof token !== "string" || token.length > 400) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = createHmac("sha256", secret).update(`huddle:${payload}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { p, e, i } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof p !== "string" || typeof e !== "number" || e * 1000 < nowMs) return null;
    return { phone: p, issuedAt: typeof i === "number" ? i : 0 };
  } catch {
    return null;
  }
}
