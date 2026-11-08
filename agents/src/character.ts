// One character turn: prompt -> Gemini -> number checker -> (retry once if time allows) -> template fallback.
import { readFileSync } from "node:fs";
import type { Account, CharacterId, FactsSnapshot, FinanceEvent, IndicatorId, Plan } from "../../contracts/src";
import { bottomLine } from "./bottomline";
import { checkMessage } from "./checker";
import { geminiQuota, parseQuotaError, QuotaError } from "./quota";

const contractsDir = new URL("../../contracts/", import.meta.url);

export interface CastMember {
  id: CharacterId;
  name: string;
  emoji: string;
  account: Account["id"] | null;
  voice: string;
  /** What this account argues for, so characters take a side instead of being vague. */
  wants: string;
  speaks_on: string[];
}

export const cast: CastMember[] = JSON.parse(readFileSync(new URL("cast.json", contractsDir), "utf8")).characters;
export const config = JSON.parse(readFileSync(new URL("agents-config.json", contractsDir), "utf8"));

export function character(id: CharacterId): CastMember {
  const c = cast.find((x) => x.id === id);
  if (!c) throw new Error(`unknown character ${id}`);
  return c;
}

const account = (facts: FactsSnapshot, id: Account["id"]) => facts.accounts.find((a) => a.id === id);
const indicator = (facts: FactsSnapshot, id: IndicatorId) => facts.indicators.find((i) => i.id === id);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * How Checking gets from today's balance to its lowest point before payday, computed in code so Checking can show
 * its math: balance now - bills due by then - everyday spending = lowest. Null if the numbers don't line up.
 */
export function lowestBreakdown(facts: FactsSnapshot) {
  const start = account(facts, "checking")?.balance;
  const low = facts.forecast.lowestBeforeNextPayday;
  if (start == null || !low) return null;
  const bills = facts.upcomingBills.filter((b) => b.dueDate >= facts.localDate && b.dueDate <= low.date);
  const billsTotal = round2(bills.reduce((s, b) => s + b.amount, 0));
  const everydaySpending = round2(start - billsTotal - low.balance);
  if (everydaySpending < 0) return null;
  return {
    balanceNow: start,
    billsBeforeLowest: bills.map((b) => ({ label: b.label, amount: b.amount, dueDate: b.dueDate })),
    billsTotal,
    everydaySpending,
    lowest: low.balance,
    lowestDate: low.date,
    nextPayday: facts.forecast.nextPayday,
  };
}

/** Months to pay off `balance` at monthly rate `r` with payment `pay` (standard amortization). Null if it never ends. */
function monthsToPayOff(balance: number, r: number, pay: number): number | null {
  if (pay <= 0) return null;
  if (r === 0) return balance / pay;
  if (pay <= balance * r) return null;
  return -Math.log(1 - (r * balance) / pay) / Math.log(1 + r);
}

/**
 * Any loan, broken down (computed in code so the Loan character can say every number): what's owed, the rate, how
 * this month's payment splits between interest and principal, when it's paid off at this pace, the interest still
 * to pay, and what an extra $100 a month would change. Standard amortization from the APR and payment; P1's engine
 * doesn't accrue loan interest yet, so these are estimates ("about").
 */
export function loanBreakdown(facts: FactsSnapshot, extraPerMonth = 100) {
  const l = account(facts, "car_loan");
  if (!l || !(l.balance > 0) || !l.monthlyPayment) return null;
  return amortize({ label: l.name, owed: l.balance, aprPercent: l.aprPercent ?? 0, monthlyPayment: l.monthlyPayment }, facts.localDate, extraPerMonth);
}

/** The same breakdown for any loan (the bank's, or one the user told us about), from today's date. */
export function amortize(loan: { label: string; owed: number; aprPercent: number; monthlyPayment: number }, localDate: string, extraPerMonth = 100) {
  const apr = loan.aprPercent;
  const r = apr / 100 / 12;
  const interestThisMonth = round2(loan.owed * r);
  const principalThisMonth = round2(Math.max(0, loan.monthlyPayment - interestThisMonth));
  const n = monthsToPayOff(loan.owed, r, loan.monthlyPayment);
  if (n == null) return null;
  const monthsLeft = Math.ceil(n - 1e-9);
  const payoff = new Date(`${localDate}T12:00:00Z`);
  payoff.setUTCMonth(payoff.getUTCMonth() + monthsLeft);
  const totalInterestLeft = round2(Math.max(0, n * loan.monthlyPayment - loan.owed));
  const nExtra = monthsToPayOff(loan.owed, r, loan.monthlyPayment + extraPerMonth)!;
  const monthsSooner = Math.max(0, monthsLeft - Math.ceil(nExtra - 1e-9));
  const interestSaved = round2(Math.max(0, totalInterestLeft - (nExtra * (loan.monthlyPayment + extraPerMonth) - loan.owed)));
  const l = { name: loan.label, balance: loan.owed, monthlyPayment: loan.monthlyPayment };
  return {
    label: l.name, owed: l.balance, aprPercent: apr, monthlyPayment: l.monthlyPayment,
    interestThisMonth, principalThisMonth, monthsLeft,
    yearsLeft: Math.round((monthsLeft / 12) * 10) / 10,
    payoffMonth: payoff.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
    payoffYear: payoff.getUTCFullYear(),
    totalInterestLeft, extraPerMonth, monthsSooner, interestSaved,
  };
}

/** What the card balance costs in interest each month (balance x APR / 12), computed in code so Card can say it. */
export function cardMonthlyInterest(facts: FactsSnapshot): number | null {
  const c = account(facts, "card");
  return c?.aprPercent ? round2((c.balance * c.aprPercent) / 100 / 12) : null;
}

/**
 * The savings cushion in words a person can picture: how long savings would cover the must-pay bills if income
 * stopped. "about 2 weeks" under a month, "about 1.5 months" after that. Computed in code (so the checker accepts
 * the numbers) from P1's runway indicator: savings / monthly essential bills.
 */
export function cushionWords(facts: FactsSnapshot, savingsBalance?: number): { span: string; weeks: number | null; months: number; monthlyBills: number; sentence: string } | null {
  const runway = indicator(facts, "runway");
  const monthlyBills = Number(runway?.inputs.monthlyEssentials ?? 0);
  const savings = savingsBalance ?? account(facts, "savings")?.balance;
  if (!runway || !monthlyBills || savings == null) return null;
  const months = round2(savings / monthlyBills);
  const weeks = months < 1 ? Math.round((months * 52) / 12) : null;
  const span = months < 1
    ? weeks! < 1 ? "less than a week" : `about ${weeks} week${weeks === 1 ? "" : "s"}`
    : `about ${Math.round(months * 10) / 10} month${Math.round(months * 10) / 10 === 1 ? "" : "s"}`;
  return {
    span, weeks, months, monthlyBills,
    sentence: `If your income stopped, your ${fmtUsd(savings)} in savings would cover ${span} of must-pay bills (${fmtUsd(monthlyBills)} a month for things like rent and utilities).`,
  };
}

/**
 * Only the slice of facts this character talks about, so the model has less to mix up.
 * `event` is the event being reacted to (defaults to the most recent one).
 */
export function factsFor(id: CharacterId, facts: FactsSnapshot, event?: FinanceEvent | null): Record<string, unknown> {
  const f = facts.forecast;
  const latestEvent = event === undefined ? (facts.recentEvents.at(-1) ?? null) : event;
  const slice: Record<CharacterId, Record<string, unknown>> = {
    checking: {
      account: account(facts, "checking"),
      lowestBeforeNextPayday: f.lowestBeforeNextPayday,
      firstNegativeDate: f.firstNegativeDate,
      nextPayday: f.nextPayday,
      safeToSpendUntilPayday: f.safeToSpendUntilPayday,
      /** The buffer the user likes to keep in Checking (say "buffer", not "cushion": the cushion is Savings'). */
      buffer: f.cushion,
      upcomingBills: facts.upcomingBills,
      shortfall: facts.shortfall,
      lowestBreakdown: lowestBreakdown(facts),
    },
    savings: { account: account(facts, "savings"), runway: indicator(facts, "runway"), savingsRate: indicator(facts, "savings_rate"), cushion: cushionWords(facts) },
    card: { account: account(facts, "card"), utilization: indicator(facts, "credit_utilization"), monthlyInterest: cardMonthlyInterest(facts) },
    car_loan: { account: account(facts, "car_loan"), billReliability: indicator(facts, "bill_reliability"), breakdown: loanBreakdown(facts) },
    ira: { account: account(facts, "ira"), retirementOnTrack: indicator(facts, "retirement_on_track") },
    coach: { ...facts, cushion: cushionWords(facts) },
  };
  return { ...slice[id], event: latestEvent, pendingProposals: facts.pendingProposals };
}

const fmtUsd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The few numbers this character should lead with, already formatted the way it should say them.
 * Every value comes straight from the facts, so the checker accepts them as written.
 */
export function keyNumbers(id: CharacterId, facts: FactsSnapshot, event?: FinanceEvent | null): string[] {
  const a = (x: Account["id"]) => account(facts, x);
  const ind = (x: IndicatorId) => indicator(facts, x);
  const f = facts.forecast;
  const s = facts.shortfall;
  const out: string[] = [];
  const amount = event && typeof event.data.amount === "number" ? fmtUsd(event.data.amount) : null;
  const what = typeof event?.data.label === "string" ? event.data.label : event?.type.replace(/_/g, " ");
  if (event && amount) out.push(`what just happened: ${what} of ${amount}${event.data.merchant ? ` at ${event.data.merchant}` : ""}`);
  switch (id) {
    case "checking":
      out.push(`your balance: ${fmtUsd(a("checking")!.balance)}`);
      if (s) out.push(`short by ${fmtUsd(s.amount)} on ${fmtDate(s.firstNegativeDate)}`, `a transfer of ${fmtUsd(s.suggestedTransfer)} fixes it`);
      else out.push(`safe to spend until payday: ${fmtUsd(f.safeToSpendUntilPayday)}`);
      out.push(`next payday: ${fmtDate(f.nextPayday)}`);
      {
        const b = lowestBreakdown(facts);
        if (b)
          out.push(
            `how your lowest point before payday is worked out: ${fmtUsd(b.balanceNow)} now, minus bills ${fmtUsd(b.billsTotal)}` +
              (b.billsBeforeLowest.length ? ` (${b.billsBeforeLowest.map((x) => `${x.label} ${fmtUsd(x.amount)} on ${fmtDate(x.dueDate)}`).join(", ")})` : "") +
              `, minus everyday spending ${fmtUsd(b.everydaySpending)}, ${b.lowest < 0 ? `puts you ${fmtUsd(b.lowest)} below zero` : `leaves ${fmtUsd(b.lowest)}`} on ${fmtDate(b.lowestDate)}`,
          );
      }
      break;
    case "savings":
      out.push(`your balance: ${fmtUsd(a("savings")!.balance)}`);
      {
        const c = cushionWords(facts);
        if (c) out.push(`what your savings means in plain words (put it in your own words; never "months of essentials" or "runway"): ${c.sentence}`);
      }
      break;
    case "card": {
      const c = a("card")!;
      out.push(`balance owed: ${fmtUsd(c.balance)}`, `APR: ${c.aprPercent}%`, `utilization: ${ind("credit_utilization")!.value}%`);
      const interest = cardMonthlyInterest(facts);
      if (interest) out.push(`monthly interest on this balance: ${fmtUsd(interest)}`);
      break;
    }
    case "car_loan": {
      const l = a("car_loan")!;
      out.push(`still owed: ${fmtUsd(l.balance)}`, `monthly payment: ${fmtUsd(l.monthlyPayment ?? 0)}`);
      const b = loanBreakdown(facts);
      if (b)
        out.push(
          `interest rate (APR): ${b.aprPercent}%`,
          `this month's payment splits into about ${fmtUsd(b.interestThisMonth)} interest and ${fmtUsd(b.principalThisMonth)} toward what you owe`,
          `paid off in about ${b.monthsLeft} months (${b.payoffMonth}) at this pace, with about ${fmtUsd(b.totalInterestLeft)} of interest still to pay`,
          `paying an extra ${fmtUsd(b.extraPerMonth)} a month would finish about ${b.monthsSooner} months sooner and save about ${fmtUsd(b.interestSaved)} in interest`,
          `say "your loan", not "your car loan"`,
        );
      break;
    }
    case "ira": {
      const i = a("ira")!;
      out.push(`balance: ${fmtUsd(i.balance)}`);
      if (i.unclaimedMatchThisYear) out.push(`employer match left unclaimed this year: ${fmtUsd(i.unclaimedMatchThisYear)}`);
      break;
    }
    case "coach":
      if (s) out.push(`Checking is short by ${fmtUsd(s.amount)} on ${fmtDate(s.firstNegativeDate)}`);
      break;
  }
  return out;
}

export function buildPrompt(
  id: CharacterId,
  facts: FactsSnapshot,
  situation: string,
  event?: FinanceEvent | null,
  plan?: Plan | null,
  ask?: string | null,
  heard?: Array<{ name: string; text: string }>,
): string {
  const c = character(id);
  const isCoach = id === "coach";
  return [
    `You are ${c.name}${c.account ? ", one of the user's bank accounts," : ""} in a group chat with the user and their other accounts.`,
    `Personality: ${c.voice}`,
    `Your job: ${c.wants}`,
    ``,
    `How to write:`,
    `- Talk TO the user as "you". Never use their name or call them "the user".`,
    isCoach
      ? `- Start with "Bottom line:" and the one thing to do now, in plain words, and why (one sentence). If the plan has more parts, mention them in one short sentence as extras for later. At most 3 short sentences.`
      : `- One message, at most 2 short sentences: the one number that matters most right now, from KEY NUMBERS, and what it means for the user in plain words (like "that costs you $X a month in interest").`,
    ...(isCoach ? [] : [`- Explain, don't persuade. Never ask for the money yourself ("put it in me", "send it to me", "pay me first"); say what it would do for the user.`]),
    ...(!isCoach && heard?.length
      ? [`- If you genuinely agree with or build on what one of the others said, you may open by saying so by name, professionally (like "Agreed with IRA on this one." or "Adding to Checking:"). If you're making your own separate point, skip that and just make it.`]
      : []),
    `- Calm and confident. Never say you're nervous, worried or scared, and never tell the user to "be careful". No slang.`,
    `- Sound like a friendly text from someone who's good with money: everyday words, short sentences. No jargon: say "must-pay bills" not "essentials", "how long your savings would last" not "runway", "the interest rate (APR)" the first time you mention APR.`,
    `- Copy numbers and dates exactly as written in KEY NUMBERS or FACTS. Never add, subtract, round, or invent a number.`,
    `- Plain words, no emoji, no "${c.name}:" prefix, no hashtags.`,
    `- You can't move money and never ask for passwords, codes, or account numbers. No specific investment picks.`,
    `- If they ask for a link, the dashboard, or the Huddle page, tell them to text "huddle link" and they'll get one. Never say you can't give links.`,
    ``,
    `KEY NUMBERS:`,
    ...keyNumbers(id, facts, event).map((k) => `- ${k}`),
    ...(heard?.length ? [``, `WHAT THE OTHERS JUST SAID:`, ...heard.map((h) => `- ${h.name}: ${h.text}`)] : []),
    ...(isCoach && plan
      ? [
          ``,
          `PLAN (from the finance engine): ${JSON.stringify(plan)}`,
          ...(plan.lines[0]
            ? (() => {
                const winner = destName(String(plan.lines[0].destination));
                const why = REASON[plan.lines[0].reasonCode] ?? plan.lines[0].reasonCode;
                return heard?.some((h) => h.name === winner)
                  ? [`The plan agrees with ${winner} (${why}). If you name an account the plan agrees with, it's ${winner}, not another account.`]
                  : [`The plan sends money to ${winner} (${why}), but ${winner} hasn't spoken. Don't say anyone "is right"; just give the reason in plain words.`];
              })()
            : []),
          ask
            ? `End with exactly: "${doLine(ask)}" (the user makes the move themselves; you can't move money, so never ask them to reply YES).`
            : `End by naming the first move to make in their bank app. Never ask them to reply YES.`,
        ]
      : []),
    ``,
    `FACTS (for reference): ${JSON.stringify(factsFor(id, facts, event))}`,
    ``,
    `SITUATION: ${situation}`,
  ].join("\n");
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Grounded fallback built only from facts, so it always passes the checker. */
const DEST: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Loan", ira: "IRA" };
const destName = (d: string) => DEST[d] ?? d.replace(/^goal:/, "your ").replace(/_/g, " ") + (d.startsWith("goal:") ? " goal" : "");

const REASON: Record<string, string> = {
  cover_shortfall: "so Checking doesn't go negative",
  pay_high_interest_debt: "to cut the highest interest first",
  build_emergency_fund: "so your savings covers more weeks of bills",
  capture_employer_match: "to grab the free employer match",
  fund_goal: "toward your goal",
  extra_retirement: "for retirement",
  extra_debt_payment: "to pay down debt",
};

/**
 * The one move the user makes, as the Coach says it: "Move $150.00 from Checking to IRA in your bank app."
 * The Coach can't move money, so it never asks for a YES; the plan is checked off when P1 sees the transfer.
 */
export const doLine = (ask: string) => `${ask} in your bank app.`;

/** Coach's grounded plan message. `ask` is the proposal's action text: the one move the user makes. */
export function planTemplate(plan: Plan, ask?: string | null): string {
  const [first, ...rest] = plan.lines.filter((l) => l.amount > 0);
  if (!first) return ask ? `Bottom line: ${doLine(ask)}` : `Bottom line: nothing to move right now.`;
  const head = `Bottom line: ${usd(first.amount)} to ${destName(first.destination)} ${REASON[first.reasonCode] ?? ""}`.trim() + ".";
  const keep = rest.filter((l) => l.destination === "checking" && l.reasonCode === "cover_shortfall");
  const later = rest.filter((l) => !keep.includes(l));
  const extra =
    keep.map((l) => ` Keep ${usd(l.amount)} in Checking so you're not short before payday.`).join("") +
    // Anything the move line doesn't already name is listed, so no part of the plan goes unmentioned.
    (later.filter((l) => !ask?.includes(usd(l.amount))).length
      ? ` The plan also suggests ${later.filter((l) => !ask?.includes(usd(l.amount))).map((l) => `${usd(l.amount)} to ${destName(l.destination)}`).join(" and ")} for later.`
      : "");
  return ask ? `${head}${extra} ${doLine(ask)}` : `${head}${extra} Tell me if you'd like a different split.`;
}

export function template(id: CharacterId, facts: FactsSnapshot, plan?: Plan | null, ask?: string | null): string {
  if (id === "coach" && plan) return planTemplate(plan, ask);
  const a = (x: Account["id"]) => account(facts, x)!;
  switch (id) {
    case "card":
      return cardMonthlyInterest(facts)
        ? `You owe ${usd(a("card").balance)} at ${a("card").aprPercent}% APR, which costs about ${usd(cardMonthlyInterest(facts)!)} a month in interest. Paying it down cuts that cost.`
        : `You owe ${usd(a("card").balance)} at ${a("card").aprPercent}% APR. Paying it down cuts the interest you pay.`;
    case "checking":
      return facts.forecast.firstNegativeDate
        ? `Checking is at ${usd(a("checking").balance)}, and the forecast dips below zero before payday.`
        : `I'm at ${usd(a("checking").balance)}; safe to spend until payday is ${usd(facts.forecast.safeToSpendUntilPayday)}.`;
    case "savings":
      return cushionWords(facts)?.sentence ?? `Your savings is at ${usd(a("savings").balance)}.`;
    case "car_loan": {
      const b = loanBreakdown(facts);
      return b
        ? `Your loan has ${usd(b.owed)} left at ${b.aprPercent}%. Of this month's ${usd(b.monthlyPayment)} payment, about ${usd(b.interestThisMonth)} is interest and ${usd(b.principalThisMonth)} lowers what you owe; at this pace it's paid off around ${b.payoffMonth}.`
        : `Your loan payment of ${usd(a("car_loan").monthlyPayment ?? 0)} comes out every month, with ${usd(a("car_loan").balance)} still owed.`;
    }
    case "ira":
      return a("ira").unclaimedMatchThisYear
        ? `${usd(a("ira").unclaimedMatchThisYear!)} of employer match is still unclaimed this year. Contributing would capture that free money.`
        : `Your IRA is at ${usd(a("ira").balance)}.`;
    case "coach":
      return bottomLine(facts, null);
  }
}

/** Plain-language fallback for "explain…" questions, built from facts. Used when Gemini's answer can't be sent. */
export function explainTemplate(id: CharacterId, facts: FactsSnapshot): string {
  const a = (x: Account["id"]) => account(facts, x);
  const f = facts.forecast;
  const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  switch (id) {
    case "savings": {
      const c = cushionWords(facts);
      return `Think of savings as your backup if a paycheck didn't come. Right now it would pay your must-pay bills for ${c?.span ?? "a short while"}. A common first target is one month of those bills.`;
    }
    case "card": {
      const card = a("card");
      const interest = cardMonthlyInterest(facts);
      return card?.aprPercent && interest
        ? `APR is the yearly interest rate on what you owe. On your ${usd(card.balance)} balance at ${card.aprPercent}%, that's about ${usd(interest)} a month. Paying the balance down shrinks that charge.`
        : `APR is the yearly interest rate the card charges on what you owe. Paying the balance down shrinks that charge.`;
    }
    case "checking":
      return facts.shortfall
        ? `A shortfall means Checking would dip below zero before payday. Right now you'd be short ${usd(facts.shortfall.amount)} on ${day(facts.shortfall.firstNegativeDate)}, and a ${usd(facts.shortfall.suggestedTransfer)} transfer fixes it.`
        : `"Safe to spend" is what you can spend before payday on ${day(f.nextPayday)} and still keep your ${usd(f.cushion)} buffer in Checking. Right now that's ${usd(f.safeToSpendUntilPayday)}.`;
    case "ira": {
      const ira = a("ira");
      return ira?.unclaimedMatchThisYear
        ? `An employer match means your job adds money to your IRA when you put money in. You still have ${usd(ira.unclaimedMatchThisYear)} of that free money unclaimed this year.`
        : `Your IRA is money set aside for retirement. It's at ${usd(ira?.balance ?? 0)} right now.`;
    }
    case "car_loan": {
      const b = loanBreakdown(facts);
      if (!b) return `Your loan payment comes out each month; extra payments shorten the loan and cut the interest.`;
      return `Each ${usd(b.monthlyPayment)} payment pays that month's interest first (about ${usd(b.interestThisMonth)} now), and the rest, ${usd(b.principalThisMonth)}, lowers what you owe. At this pace your ${usd(b.owed)} is paid off around ${b.payoffMonth}. An extra ${usd(b.extraPerMonth)} a month would finish about ${b.monthsSooner} months sooner and save about ${usd(b.interestSaved)}.`;
    }
    case "coach":
      return `Here's the short version: each account watches one part of your money, and I turn what they say into one simple move you make in your bank app. Ask about any word and I'll break it down.`;
  }
}

/** Call Gemini over REST (no SDK dependency). */
export async function callModel(prompt: string, opts: { model: string; apiKey: string; timeoutMs: number }): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: config.character_model.max_output_tokens, temperature: config.character_model.temperature },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (res.status === 429) {
    const err = parseQuotaError(await res.text());
    geminiQuota.record(err);
    throw err;
  }
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  geminiQuota.ok();
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").replace(/\s*\n+\s*/g, " ").trim();
}

/** GPT writes the characters' lines when OPENAI_API_KEY is set (CHARACTER_PROVIDER=gemini switches it back). */
export function usingOpenAI(): boolean {
  return !!process.env.OPENAI_API_KEY && process.env.CHARACTER_PROVIDER !== "gemini";
}

/** Call OpenAI's chat completions over REST (no SDK dependency). Same job and limits as the Gemini call. */
export async function callOpenAI(prompt: string, opts: { model: string; apiKey: string; timeoutMs: number }): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: config.character_model.max_output_tokens,
      // No hidden "thinking": a short text reply should come back in about a second.
      ...(config.character_model.openai_reasoning_effort ? { reasoning_effort: config.character_model.openai_reasoning_effort } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  return (data.choices?.[0]?.message?.content ?? "").replace(/\s*\n+\s*/g, " ").trim();
}

export interface SpeakResult {
  text: string;
  source: "model" | "retry" | "template";
  attempts: Array<{ text?: string; ok?: boolean; ungrounded?: Array<{ raw: string }>; error?: string }>;
  ms: number;
}

/**
 * Extra rules for the Coach's plan message, enforced in code like the number checker:
 * the exact YES line must be there (it is what the user approves), and it may not crown the wrong account.
 */
export function coachProblem(
  id: CharacterId,
  text: string,
  plan?: Plan | null,
  ask?: string | null,
  heard?: Array<{ name: string; text: string }>,
): string | null {
  if (id !== "coach") return null;
  const crowned = [...text.matchAll(/\b(Checking|Savings|Card|Car Loan|Loan|IRA)\s+(?:is|was)\s+(?:also\s+)?right\b/gi)].map((m) => m[1].toLowerCase());
  if (!plan) {
    // No plan (a plain chat answer): only an account that just argued may be called "right".
    const spoke = (n: string) => heard?.some((h) => h.name.toLowerCase() === n) ?? false;
    if (crowned.some((n) => !spoke(n))) return `Don't say any account "is right"; nobody argued. Just answer the question.`;
    // Closing a debate with nothing to approve: a bottom line, and never a YES invite (it could approve something else).
    if (heard?.length) {
      if (/reply yes/i.test(text)) return `There's no plan to approve here; don't ask them to reply YES.`;
      if (!/^\s*Bottom line:/i.test(text)) return `Start with "Bottom line:" and whether they need to do anything now.`;
    }
    return null;
  }
  if (/reply yes|say yes|text yes/i.test(text)) return `Don't ask them to reply YES; you can't move money. Tell them the move to make in their bank app.`;
  if (ask && !text.toLowerCase().includes(doLine(ask).toLowerCase().replace(/\.$/, ""))) return `It must end with exactly "${doLine(ask)}"`;
  if (!/^\s*Bottom line:/i.test(text)) return `Start with "Bottom line:" and the one thing to do now.`;
  const first = plan.lines[0];
  if (!first) return null;
  const winner = destName(String(first.destination));
  const winnerSpoke = heard?.some((h) => h.name === winner) ?? false;
  if (crowned.some((n) => n !== winner.toLowerCase()) || (crowned.length && !winnerSpoke))
    return winnerSpoke ? `Only ${winner} is right here; the plan sides with ${winner}.` : `Don't say any account "is right"; ${winner} didn't speak.`;
  return null;
}

/**
 * House style, enforced in code like the number checker (one retry, then the template):
 * accounts explain instead of asking for the money, and nobody sounds nervous or uses slang.
 */
export function styleProblem(id: CharacterId, text: string): string | null {
  if (id !== "coach" && /\b(send|put|give|move|transfer|pay|throw|toss)\b[^.?!]{0,40}\b(to|into|in|toward|with|my way)\s+me\b|\bpay me\b|\bmy way\b|\b(right )?here (with|in) me\b|\bbelongs? (here|with me|down here|right here)\b|\bwhere (it|they|that|this) belongs?\b|\b(put|send|move|transfer|give|throw|toss)\b[^.?!]{0,40}\b(right |over |down )?here\b/i.test(text))
    return `Explain what it means for the user instead of asking for the money ("put it in me", "pay me first").`;
  if (/\b(nervous|anxious|worried|worry|scared|scary|panic\w*|freak\w*|be careful|stressed|terrif\w*)\b/i.test(text))
    return `Keep the tone calm and confident: no "nervous", "worried" or "be careful".`;
  if (/\b(lol|lmao|bro|dude|ngl|tbh|fr|gonna|wanna|gotta|yo|bruh|omg)\b/i.test(text)) return `No slang; keep it professional.`;
  // A reply that hit the length limit mid-sentence ("…an extra $100.00 a month would") is never sent as is.
  if (!/[.!?]["'”’)\]]?\s*$/.test(text.trim())) return `Your reply got cut off. Say it in fewer words and end with a full sentence.`;
  return null;
}

/** An explanation that opens with the same sentence it's explaining isn't an explanation. */
export function repeatProblem(text: string, avoid?: string[]): string | null {
  if (!avoid?.length) return null;
  const opening = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0].slice(0, 60);
  const mine = opening(text);
  return avoid.some((a) => a && opening(a) === mine) ? `Don't repeat your earlier message; say it a new, simpler way.` : null;
}

/**
 * Produce one grounded line for a character.
 * opts.model replaces Gemini in tests; opts.deadline is a real-clock ms timestamp (delivery timing, not calendar).
 */
export async function speak(
  id: CharacterId,
  facts: FactsSnapshot,
  situation: string,
  opts: {
    model?: (prompt: string) => Promise<string>; deadline?: number; event?: FinanceEvent | null; plan?: Plan | null; ask?: string | null;
    heard?: Array<{ name: string; text: string }>; extraSources?: unknown[];
    /** Earlier messages this reply must not open the same way as (an "explain that" must rephrase, not repeat). */
    avoidRepeating?: string[];
    /** Exact phrases the reply must include, with why (e.g. the total owed on all loans). One retry, then the template. */
    mustMention?: Array<{ text: string; why: string }>;
  } = {},
): Promise<SpeakResult> {
  const started = Date.now();
  const cm = config.character_model;
  const deadline = opts.deadline ?? started + config.debate.first_message_target_ms;
  const timeoutMs = () => Math.max(500, Math.min(cm.timeout_ms, deadline - Date.now()));
  const gemini = (p: string) => callModel(p, { model: process.env.CHARACTER_MODEL || cm.model, apiKey: process.env.GEMINI_API_KEY ?? "", timeoutMs: timeoutMs() });
  const gpt = usingOpenAI();
  const model =
    opts.model ??
    (gpt
      ? // GPT writes the line; if it errors or is rate-limited, Gemini answers instead (same checks either way).
        async (p: string) => {
          try {
            return await callOpenAI(p, { model: process.env.OPENAI_MODEL || cm.openai_model, apiKey: process.env.OPENAI_API_KEY!, timeoutMs: timeoutMs() });
          } catch (err) {
            if (!process.env.GEMINI_API_KEY || geminiQuota.limited()) throw err;
            console.warn(`[agents] GPT failed (${(err as Error).message.slice(0, 80)}); Gemini answered instead`);
            return gemini(p);
          }
        }
      : gemini);
  const attempts: SpeakResult["attempts"] = [];
  let prompt = buildPrompt(id, facts, situation, opts.event, opts.plan, opts.ask, opts.heard);
  const sources = [factsFor(id, facts, opts.event), ...(opts.plan ? [opts.plan] : []), ...(opts.extraSources ?? [])];

  for (const source of ["model", "retry"] as const) {
    if (source === "retry" && deadline - Date.now() < config.debate.checker_retry_only_if_ms_remaining) break;
    if (!opts.model && !gpt && geminiQuota.limited()) {
      attempts.push({ error: `skipped: Gemini ${geminiQuota.status().scope ?? ""} limit` });
      break;
    }
    try {
      const text = await model(prompt);
      // Checked against this character's own slice, not all 45 forecast days, so stray numbers can't sneak through.
      const check = checkMessage(text, ...sources);
      const missed = opts.mustMention?.find((m) => !text.includes(m.text));
      const problem = check.ok
        ? (coachProblem(id, text, opts.plan, opts.ask, opts.heard) ?? styleProblem(id, text) ?? repeatProblem(text, opts.avoidRepeating) ??
          (missed ? `Include ${missed.text} (${missed.why}).` : null))
        : null;
      attempts.push({ text, ...check, ...(problem ? { ok: false, error: problem } : {}) });
      if (check.ok && !problem && text) return { text, source, attempts, ms: Date.now() - started };
      prompt += problem
        ? `\nYour last reply had a problem: ${problem} Rewrite it.`
        : `\nYour last reply used numbers not in FACTS: ${check.ungrounded.map((u) => u.raw).join(", ")}. Rewrite without them.`;
    } catch (err) {
      attempts.push({ error: err instanceof QuotaError ? `quota (${err.scope})` : String((err as Error).message ?? err) });
      if (err instanceof QuotaError) break; // a retry would hit the same limit
    }
  }
  return { text: template(id, facts, opts.plan, opts.ask), source: "template", attempts, ms: Date.now() - started };
}
