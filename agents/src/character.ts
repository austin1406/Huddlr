// One character turn: prompt -> Gemini -> number checker -> (retry once if time allows) -> template fallback.
import { readFileSync } from "node:fs";
import type { Account, CharacterId, FactsSnapshot, FinanceEvent, IndicatorId, Plan } from "../../contracts/src";
import { checkMessage } from "./checker";

const contractsDir = new URL("../../contracts/", import.meta.url);

export interface CastMember {
  id: CharacterId;
  name: string;
  emoji: string;
  account: Account["id"] | null;
  voice: string;
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
    },
    savings: { account: account(facts, "savings"), runway: indicator(facts, "runway"), savingsRate: indicator(facts, "savings_rate") },
    card: { account: account(facts, "card"), utilization: indicator(facts, "credit_utilization") },
    car_loan: { account: account(facts, "car_loan"), billReliability: indicator(facts, "bill_reliability") },
    ira: { account: account(facts, "ira"), retirementOnTrack: indicator(facts, "retirement_on_track") },
    coach: { ...facts },
  };
  return { ...slice[id], event: latestEvent, pendingProposals: facts.pendingProposals };
}

export function buildPrompt(id: CharacterId, facts: FactsSnapshot, situation: string, event?: FinanceEvent | null, plan?: Plan | null): string {
  const c = character(id);
  const coachRules = id === "coach" && plan
    ? [`- Give exactly this plan, line by line, with its amounts. End by asking for a clear YES.`, `PLAN: ${JSON.stringify(plan)}`]
    : [];
  return [
    `You are ${c.name}, a bank account in a group chat with its owner. Personality: ${c.voice}`,
    `Rules:`,
    `- At most 2 short sentences, plain words, no emoji, no "${c.name}:" prefix.`,
    `- Use ONLY numbers and dates that appear in FACTS, copied exactly. Never compute, estimate, or invent a number.`,
    `- If you need a number that is not in FACTS, say it without a number.`,
    `- Write money like $1,186.50 and dates like Nov 20 (never 2026-11-20).`,
    `- Never move money, never ask for passwords, codes, or account numbers. No specific investment advice.`,
    `FACTS: ${JSON.stringify(factsFor(id, facts, event))}`,
    ...coachRules,
    `SITUATION: ${situation}`,
  ].join("\n");
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Grounded fallback built only from facts, so it always passes the checker. */
const DEST: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Car Loan", ira: "IRA" };
const destName = (d: string) => DEST[d] ?? d.replace(/^goal:/, "your ").replace(/_/g, " ") + (d.startsWith("goal:") ? " goal" : "");

/** Coach's grounded plan message. */
export function planTemplate(plan: Plan): string {
  const lines = plan.lines.map((l) => `${usd(l.amount)} to ${destName(l.destination)}`);
  return `Here's the plan: ${lines.join(", ")}. Reply YES to approve, or tell me what to change.`;
}

export function template(id: CharacterId, facts: FactsSnapshot, plan?: Plan | null): string {
  if (id === "coach" && plan) return planTemplate(plan);
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
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
}

export interface SpeakResult {
  text: string;
  source: "model" | "retry" | "template";
  attempts: Array<{ text?: string; ok?: boolean; ungrounded?: Array<{ raw: string }>; error?: string }>;
  ms: number;
}

/**
 * Produce one grounded line for a character.
 * opts.model replaces Gemini in tests; opts.deadline is a real-clock ms timestamp (delivery timing, not calendar).
 */
export async function speak(
  id: CharacterId,
  facts: FactsSnapshot,
  situation: string,
  opts: { model?: (prompt: string) => Promise<string>; deadline?: number; event?: FinanceEvent | null; plan?: Plan | null; extraSources?: unknown[] } = {},
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
  let prompt = buildPrompt(id, facts, situation, opts.event, opts.plan);
  const sources = [factsFor(id, facts, opts.event), ...(opts.plan ? [opts.plan] : []), ...(opts.extraSources ?? [])];

  for (const source of ["model", "retry"] as const) {
    if (source === "retry" && deadline - Date.now() < config.debate.checker_retry_only_if_ms_remaining) break;
    try {
      const text = await model(prompt);
      // Checked against this character's own slice, not all 45 forecast days, so stray numbers can't sneak through.
      const check = checkMessage(text, ...sources);
      attempts.push({ text, ...check });
      if (check.ok && text) return { text, source, attempts, ms: Date.now() - started };
      prompt += `\nYour last reply used numbers not in FACTS: ${check.ungrounded.map((u) => u.raw).join(", ")}. Rewrite without them.`;
    } catch (err) {
      attempts.push({ error: String((err as Error).message ?? err) });
    }
  }
  return { text: template(id, facts, opts.plan), source: "template", attempts, ms: Date.now() - started };
}
