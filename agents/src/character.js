// One character turn: prompt -> Gemini -> number checker -> (retry once if time allows) -> template fallback.
import fs from 'node:fs';
import { checkMessage } from './checker.js';

const contracts = new URL('../../contracts/', import.meta.url);
export const cast = JSON.parse(fs.readFileSync(new URL('cast.json', contracts))).characters;
export const config = JSON.parse(fs.readFileSync(new URL('agents-config.json', contracts)));

export const character = (id) => {
  const c = cast.find((x) => x.id === id);
  if (!c) throw new Error(`unknown character ${id}`);
  return c;
};

/** Only the slice of facts this character is allowed to talk about, so the model has less to mix up. */
export function factsFor(id, facts) {
  const { balances = {}, accounts = {}, forecast, indicators = {}, bills, events, shortfall } = facts;
  const pick = {
    checking: { balance: balances.checking, forecast, bills, shortfall },
    savings: { balance: balances.savings, emergency_fund_months: indicators.emergency_fund_months, savings_rate_pct: indicators.savings_rate_pct },
    card: { balance: balances.credit_card, ...accounts.credit_card, utilization_pct: indicators.card_utilization_pct },
    car_loan: { balance: balances.car_loan, ...accounts.car_loan },
    ira: { balance: balances.ira_simulated, match_captured_pct: indicators.match_captured_pct },
    coach: facts,
  }[id];
  return { ...pick, event: events?.[0] ?? null };
}

export function buildPrompt(id, facts, situation) {
  const c = character(id);
  return [
    `You are ${c.name}, a bank account in a group chat with its owner. Personality: ${c.voice}`,
    `Rules:`,
    `- At most 2 short sentences, plain words, no emoji, no "${c.name}:" prefix.`,
    `- Use ONLY numbers and dates that appear in FACTS, copied exactly. Never compute, estimate, or invent a number.`,
    `- If you need a number that is not in FACTS, say it without a number.`,
    `- Never move money, never ask for passwords, codes, or account numbers. No specific investment advice.`,
    `FACTS: ${JSON.stringify(factsFor(id, facts))}`,
    `SITUATION: ${situation}`,
  ].join('\n');
}

/** Grounded fallback: built only from facts, so it always passes the checker. */
export function template(id, facts) {
  const f = factsFor(id, facts);
  const $ = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  switch (id) {
    case 'card': return `I'm carrying ${$(f.balance)} at ${f.apr}% APR. Paying me down saves the most interest.`;
    case 'checking': return f.forecast?.first_negative_day
      ? `Heads up: I'm at ${$(f.balance)} and my forecast goes negative soon.`
      : `I'm at ${$(f.balance)} and the next few weeks look covered.`;
    case 'savings': return `I'm holding ${$(f.balance)}, about ${f.emergency_fund_months} months of cushion.`;
    case 'car_loan': return `My ${$(f.payment)} payment is coming up; that one can't slip.`;
    case 'ira': return `I'm at ${$(f.balance)}. Don't leave the employer match on the table.`;
    default: return `Let's look at the plan before anyone moves money.`;
  }
}

/** Call Gemini over REST (no SDK dependency). */
export async function callModel(prompt, { model, apiKey, timeoutMs }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: config.character_model.max_output_tokens, temperature: config.character_model.temperature },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
}

/**
 * Produce one grounded line for a character.
 * @param {{model?: Function, deadline?: number}} opts  model(prompt) for tests; deadline = real-clock ms timestamp
 * @returns {Promise<{text: string, source: 'model'|'retry'|'template', attempts: Array, ms: number}>}
 */
export async function speak(id, facts, situation, opts = {}) {
  const started = Date.now();
  const cm = config.character_model;
  const deadline = opts.deadline ?? started + config.debate.first_message_target_ms;
  const model = opts.model ?? ((p) => callModel(p, {
    model: process.env.CHARACTER_MODEL || cm.model,
    apiKey: process.env.GEMINI_API_KEY,
    timeoutMs: Math.max(500, Math.min(cm.timeout_ms, deadline - Date.now())),
  }));
  const attempts = [];
  let prompt = buildPrompt(id, facts, situation);

  for (const source of ['model', 'retry']) {
    if (source === 'retry' && deadline - Date.now() < config.debate.checker_retry_only_if_ms_remaining) break;
    try {
      const text = await model(prompt);
      const check = checkMessage(text, facts);
      attempts.push({ text, ...check });
      if (check.ok && text) return { text, source, attempts, ms: Date.now() - started };
      prompt += `\nYour last reply used numbers not in FACTS: ${check.ungrounded.map((u) => u.raw).join(', ')}. Rewrite without them.`;
    } catch (err) {
      attempts.push({ error: String(err.message ?? err) });
    }
  }
  return { text: template(id, facts), source: 'template', attempts, ms: Date.now() - started };
}
