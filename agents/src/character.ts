// One character turn: prompt -> Gemini -> number checker -> (retry once if time allows) -> template fallback.
import { readFileSync } from "node:fs";
import type { Account, CharacterId, FactsSnapshot, FinanceEvent, IndicatorId, Plan } from "../../contracts/src";
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
      cushion: f.cushion,
      upcomingBills: facts.upcomingBills,
      shortfall: facts.shortfall,
      lowestBreakdown: lowestBreakdown(facts),
    },
    savings: { account: account(facts, "savings"), runway: indicator(facts, "runway"), savingsRate: indicator(facts, "savings_rate") },
    card: { account: account(facts, "card"), utilization: indicator(facts, "credit_utilization") },
    car_loan: { account: account(facts, "car_loan"), billReliability: indicator(facts, "bill_reliability") },
    ira: { account: account(facts, "ira"), retirementOnTrack: indicator(facts, "retirement_on_track") },
    coach: { ...facts },
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
              `, minus everyday spending ${fmtUsd(b.everydaySpending)}, leaves ${fmtUsd(b.lowest)} on ${fmtDate(b.lowestDate)}`,
          );
      }
      break;
    case "savings":
      out.push(`your balance: ${fmtUsd(a("savings")!.balance)}`, `cushion: ${ind("runway")!.value} months of essentials`);
      break;
    case "card": {
      const c = a("card")!;
      out.push(`balance owed: ${fmtUsd(c.balance)}`, `APR: ${c.aprPercent}%`, `utilization: ${ind("credit_utilization")!.value}%`);
      break;
    }
    case "car_loan": {
      const l = a("car_loan")!;
      out.push(`monthly payment: ${fmtUsd(l.monthlyPayment ?? 0)}`, `still owed: ${fmtUsd(l.balance)}`);
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
    `You always argue for: ${c.wants}`,
    ``,
    `How to write:`,
    `- Talk TO the user as "you". Never use their name or call them "the user".`,
    isCoach
      ? `- At most 3 short sentences: say who is right and why in one sentence, then the action.`
      : `- Exactly 2 short sentences. Sentence 1: the one number that matters most right now, from KEY NUMBERS. Sentence 2: what you want to happen, from your side, even if the others disagree.`,
    `- Copy numbers and dates exactly as written in KEY NUMBERS or FACTS. Never add, subtract, round, or invent a number.`,
    `- Plain words, no emoji, no "${c.name}:" prefix, no hashtags.`,
    `- You can't move money and never ask for passwords, codes, or account numbers. No specific investment picks.`,
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
                  ? [`The plan sides with ${winner} (${why}). Say ${winner} is right, not another account.`]
                  : [`The plan sends money to ${winner} (${why}), but ${winner} hasn't spoken. Don't say anyone "is right"; just give the reason in plain words.`];
              })()
            : []),
          `End with exactly: "Reply YES to: ${ask ?? "this plan"}."`,
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
const DEST: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Car Loan", ira: "IRA" };
const destName = (d: string) => DEST[d] ?? d.replace(/^goal:/, "your ").replace(/_/g, " ") + (d.startsWith("goal:") ? " goal" : "");

const REASON: Record<string, string> = {
  cover_shortfall: "so Checking doesn't go negative",
  pay_high_interest_debt: "to cut the highest interest first",
  build_emergency_fund: "to grow your cushion",
  capture_employer_match: "to grab the free employer match",
  fund_goal: "toward your goal",
  extra_retirement: "for retirement",
  extra_debt_payment: "to pay down debt",
};

/** Coach's grounded plan message. `ask` is the proposal's action text, the one thing a YES approves. */
export function planTemplate(plan: Plan, ask?: string | null): string {
  const lines = plan.lines.map((l) => `${usd(l.amount)} to ${destName(l.destination)} ${REASON[l.reasonCode] ?? ""}`.trim());
  const head = lines.length === 1 ? `Here's the call: ${lines[0]}.` : `Here's the plan: ${lines.join("; ")}.`;
  return ask ? `${head} Reply YES to: ${ask}.` : `${head} Reply YES to approve, or tell me what to change.`;
}

export function template(id: CharacterId, facts: FactsSnapshot, plan?: Plan | null, ask?: string | null): string {
  if (id === "coach" && plan) return planTemplate(plan, ask);
  const a = (x: Account["id"]) => account(facts, x)!;
  switch (id) {
    case "card":
      return `I'm carrying ${usd(a("card").balance)} at ${a("card").aprPercent}% APR. Paying me down saves the most interest.`;
    case "checking":
      return facts.forecast.firstNegativeDate
        ? `Heads up: I'm at ${usd(a("checking").balance)} and my forecast goes negative soon.`
        : `I'm at ${usd(a("checking").balance)}; safe to spend until payday is ${usd(facts.forecast.safeToSpendUntilPayday)}.`;
    case "savings":
      return `I'm holding ${usd(a("savings").balance)}, about ${indicator(facts, "runway")!.value} months of cushion.`;
    case "car_loan":
      return `My ${usd(a("car_loan").monthlyPayment ?? 0)} payment can't slip.`;
    case "ira":
      return `I'm at ${usd(a("ira").balance)}. Don't leave the employer match on the table.`;
    case "coach":
      return `Let's look at the plan before anyone moves money.`;
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
  const crowned = [...text.matchAll(/\b(Checking|Savings|Card|Car Loan|IRA)\s+(?:is|was)\s+(?:also\s+)?right\b/gi)].map((m) => m[1].toLowerCase());
  if (!plan) {
    // No plan (a plain chat answer): only an account that just argued may be called "right".
    const spoke = (n: string) => heard?.some((h) => h.name.toLowerCase() === n) ?? false;
    return crowned.some((n) => !spoke(n)) ? `Don't say any account "is right"; nobody argued. Just answer the question.` : null;
  }
  if (ask && !text.includes(`Reply YES to: ${ask}`)) return `It must end with exactly "Reply YES to: ${ask}."`;
  const first = plan.lines[0];
  if (!first) return null;
  const winner = destName(String(first.destination));
  const winnerSpoke = heard?.some((h) => h.name === winner) ?? false;
  if (crowned.some((n) => n !== winner.toLowerCase()) || (crowned.length && !winnerSpoke))
    return winnerSpoke ? `Only ${winner} is right here; the plan sides with ${winner}.` : `Don't say any account "is right"; ${winner} didn't speak.`;
  return null;
}

/**
 * Produce one grounded line for a character.
 * opts.model replaces Gemini in tests; opts.deadline is a real-clock ms timestamp (delivery timing, not calendar).
 */
export async function speak(
  id: CharacterId,
  facts: FactsSnapshot,
  situation: string,
  opts: { model?: (prompt: string) => Promise<string>; deadline?: number; event?: FinanceEvent | null; plan?: Plan | null; ask?: string | null; heard?: Array<{ name: string; text: string }>; extraSources?: unknown[] } = {},
): Promise<SpeakResult> {
  const started = Date.now();
  const cm = config.character_model;
  const deadline = opts.deadline ?? started + config.debate.first_message_target_ms;
  const model =
    opts.model ??
    ((p: string) =>
      callModel(p, {
        model: process.env.CHARACTER_MODEL || cm.model,
        apiKey: process.env.GEMINI_API_KEY ?? "",
        timeoutMs: Math.max(500, Math.min(cm.timeout_ms, deadline - Date.now())),
      }));
  const attempts: SpeakResult["attempts"] = [];
  let prompt = buildPrompt(id, facts, situation, opts.event, opts.plan, opts.ask, opts.heard);
  const sources = [factsFor(id, facts, opts.event), ...(opts.plan ? [opts.plan] : []), ...(opts.extraSources ?? [])];

  for (const source of ["model", "retry"] as const) {
    if (source === "retry" && deadline - Date.now() < config.debate.checker_retry_only_if_ms_remaining) break;
    if (!opts.model && geminiQuota.limited()) {
      attempts.push({ error: `skipped: Gemini ${geminiQuota.status().scope ?? ""} limit` });
      break;
    }
    try {
      const text = await model(prompt);
      // Checked against this character's own slice, not all 45 forecast days, so stray numbers can't sneak through.
      const check = checkMessage(text, ...sources);
      const problem = check.ok ? coachProblem(id, text, opts.plan, opts.ask, opts.heard) : null;
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
