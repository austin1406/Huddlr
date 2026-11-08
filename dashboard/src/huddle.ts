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
export type Decision =
  | { kind: "buy"; amount: number }
  | { kind: "save"; amount: number } // Checking -> Savings
  | { kind: "pay_card"; amount: number } // Checking -> Card
  | { kind: "ira"; amount: number } // Checking -> IRA
  | { kind: "lose_income"; months: number };

export type Reaction = { id: string; mood: Mood; text: string; before?: string; after?: string; changed: boolean };
export type DecisionResult = { title: string; verdict: string; safe: boolean; reactions: Reaction[]; source: "what_if" | "math" };

export function parseDecision(body: any): Decision | null {
  const kind = body?.kind;
  if (kind === "lose_income") {
    const m = Math.round(Number(body.months));
    return m >= 1 && m <= 12 ? { kind, months: m } : null;
  }
  const amount = roundMoney(Number(body?.amount));
  if (!["buy", "save", "pay_card", "ira"].includes(kind) || !(amount > 0) || amount > 1_000_000) return null;
  return { kind, amount };
}

type WhatIf = (scenario: unknown) => Promise<any>;

export async function decide(facts: any, d: Decision, whatIf: WhatIf): Promise<DecisionResult> {
  const f = facts.forecast;
  const acct = (id: string) => facts.accounts.find((a: any) => a.id === id);
  const ind = (id: string) => facts.indicators.find((i: any) => i.id === id);
  const runway = ind("runway");
  const ess = runway?.inputs.monthlyEssentials ?? 0;
  const sv = acct("savings")?.balance ?? 0;
  const same = (id: string, text = "No change for me."): Reaction => ({ id, mood: "okay", text, changed: false });

  if (d.kind === "lose_income") {
    const r = await whatIf({ type: "lose_income", months: d.months }).catch(() => null);
    const neg = r?.after?.firstNegativeDate ?? null;
    const low = r?.after?.lowestBalance;
    const days = daysOfCover(sv, ess);
    return {
      title: `If your paycheck stopped for ${d.months} month${d.months > 1 ? "s" : ""}`,
      safe: false,
      verdict: `Savings would carry your must-pay bills for about ${days} days. A ${runway?.goodAt ?? 3}-month cushion would be ${money(roundMoney(ess * (runway?.goodAt ?? 3)))}.`,
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
        { id: "card", mood: "okay", text: `Try not to lean on me. ${acct("card")?.aprPercent ?? 0}% interest adds up fast.`, changed: false },
        { id: "car_loan", mood: neg ? "worried" : "okay", text: neg ? "My payment would be at risk." : "My payment would still go through.", changed: !!neg },
        { id: "ira", mood: "okay", text: "Leave me alone if you can. Early withdrawals cost penalties.", changed: false },
      ],
    };
  }

  const A = d.amount;
  // Buying hits Checking the same way moving money out of it does, so the forecast shifts down by A from today.
  const lowAfter = roundMoney(f.lowest.balance - A);
  const room = roomToSpend(f);
  const roomAfter = roundMoney(room - A);
  const negAfter = f.days.find((x: any) => x.balance - A < 0)?.date ?? null;

  let source: DecisionResult["source"] = "math";
  let checkingLow = lowAfter;
  let checkingNeg: string | null = negAfter;
  if (d.kind === "buy") {
    const r = await whatIf({ type: "purchase_now", amount: A }).catch(() => null);
    if (r?.after?.lowestBalance) {
      source = "what_if";
      checkingLow = r.after.lowestBalance.balance;
      checkingNeg = r.after.firstNegativeDate;
    }
  }
  const checkingSafe = !checkingNeg && roundMoney(checkingLow - f.cushion) >= 0;
  const negBill = checkingNeg ? facts.upcomingBills.find((b: any) => b.dueDate === checkingNeg) : null;
  const spare = `Checking can spare about ${money(room)} right now.`;
  const moveVerdict = (good: string) =>
    checkingNeg ? `Not right now. It would leave Checking below $0 on ${day(checkingNeg)}. ${spare}` : checkingSafe ? good : `Smaller is safer. ${spare}`;
  const checking: Reaction = {
    id: "checking",
    mood: checkingNeg ? "worried" : checkingSafe ? "happy" : "okay",
    text: checkingNeg
      ? `That puts me below $0 on ${day(checkingNeg)}${negBill ? `, when ${negBill.label.toLowerCase()} is due` : ""}.`
      : checkingSafe
        ? `Fine by me. I'd still stay above my ${money(f.cushion)} cushion.`
        : `Tight: my lowest would be ${money(checkingLow)}, under my ${money(f.cushion)} cushion.`,
    before: `lowest ${money(f.lowest.balance)}`,
    after: `lowest ${money(checkingLow)}`,
    changed: true,
  };
  const others = ["savings", "ira", "card", "car_loan"];
  const reactions: Record<string, Reaction> = Object.fromEntries(others.map((id) => [id, same(id)]));
  reactions.checking = checking;
  if (checkingNeg && reactions.car_loan) {
    const bill = facts.upcomingBills.find((b: any) => b.id === "car_loan");
    if (bill && checkingNeg <= bill.dueDate) reactions.car_loan = { id: "car_loan", mood: "worried", text: `My ${money(bill.amount)} payment on ${day(bill.dueDate)} could bounce.`, changed: true };
  }

  let title = "";
  let verdict = "";
  if (d.kind === "buy") {
    title = `If you spend ${money(A)} today`;
    verdict = checkingNeg
      ? `Not right now. It would leave Checking below $0 on ${day(checkingNeg)}. ${spare}`
      : checkingSafe
        ? `You can afford this. Checking stays above its cushion.`
        : `Possible, but it eats into your cushion. ${spare}`;
    if (runway) reactions.savings = same("savings", checkingNeg ? "If Checking runs short, you'd have to pull from me." : "No change for me.");
  } else if (d.kind === "save") {
    title = `If you move ${money(A)} from Checking to Savings`;
    const newRunway = Math.round(((sv + A) / ess) * 100) / 100;
    const st = runway ? statusFor(runway, newRunway) : "watch";
    reactions.savings = {
      id: "savings",
      mood: moodOf[st],
      text:
        daysOfCover(sv + A, ess) > daysOfCover(sv, ess)
          ? `I'd cover about ${daysOfCover(sv + A, ess)} days of must-pay bills instead of ${daysOfCover(sv, ess)}.`
          : `Every bit helps. The goal is ${money(roundMoney(ess * (runway?.goodAt ?? 3)))} (${runway?.goodAt ?? 3} months of bills).`,
      before: money(sv),
      after: money(roundMoney(sv + A)),
      changed: true,
    };
    verdict = moveVerdict(`Good move. Your safety net grows and Checking can afford it.`);
  } else if (d.kind === "pay_card") {
    const card = acct("card");
    const util = ind("credit_utilization");
    const pay = Math.min(A, card?.balance ?? A);
    const newBal = roundMoney((card?.balance ?? 0) - pay);
    const newUtil = card?.limit ? (newBal / card.limit) * 100 : 0;
    const st = util ? statusFor(util, newUtil) : "watch";
    const saved = roundMoney((pay * (card?.aprPercent ?? 0)) / 1200);
    reactions.card = {
      id: "card",
      mood: moodOf[st],
      text: `Limit used drops from ${pct(util?.value ?? 0)} to ${pct(newUtil)}. You'd pay about ${money(saved)} less interest each month.`,
      before: money(card?.balance ?? 0),
      after: money(newBal),
      changed: true,
    };
    title = `If you pay ${money(pay)} extra on the card`;
    verdict = moveVerdict(`Good move. The card has your highest interest rate, and Checking can afford it.`);
  } else if (d.kind === "ira") {
    const ira = acct("ira");
    const ret = ind("retirement_on_track");
    const target = ira?.retirementTarget ?? ret?.inputs.target ?? 0;
    const newPct = target ? ((ira.balance + A) / target) * 100 : 0;
    reactions.ira = {
      id: "ira",
      mood: ret ? moodOf[statusFor(ret, newPct)] : "okay",
      text: `I'd be at ${pct(newPct)} of your goal, up from ${pct(ret?.value ?? 0)}.${ira?.unclaimedMatchThisYear > 0 ? ` Raising your paycheck contribution also unlocks the ${money(ira.unclaimedMatchThisYear)} match.` : ""}`,
      before: money(ira?.balance ?? 0),
      after: money(roundMoney((ira?.balance ?? 0) + A)),
      changed: true,
    };
    title = `If you put ${money(A)} into your IRA`;
    verdict = moveVerdict(`Good for later. Checking can afford it right now.`);
  }

  return {
    title,
    verdict,
    safe: !checkingNeg && checkingSafe,
    source,
    reactions: ["checking", "savings", "ira", "card", "car_loan"].map((id) => reactions[id]).filter(Boolean),
  };
}

// ---------- private links ----------
/** A link that opens one person's huddle without the dashboard password. Expires (default 7 days). */
export function signLink(secret: string, phone: string, ttlSeconds = 7 * 86400, nowMs = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ p: phone, e: Math.floor(nowMs / 1000) + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`huddle:${payload}`).digest("base64url").slice(0, 32);
  return `${payload}.${sig}`;
}

export function verifyLink(secret: string, token: string, nowMs = Date.now()): { phone: string } | null {
  if (!secret || typeof token !== "string" || token.length > 400) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = createHmac("sha256", secret).update(`huddle:${payload}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { p, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof p !== "string" || typeof e !== "number" || e * 1000 < nowMs) return null;
    return { phone: p };
  } catch {
    return null;
  }
}
