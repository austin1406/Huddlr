// A text that isn't an answer to a proposal: remember any goal or preference in it, then let the right
// character answer (one speaker, grounded like everything else).
import type { CharacterId, FactsSnapshot } from "../../contracts/src";
import { speak } from "./character";
import { extractNumbers } from "./checker";
import type { Queryable } from "./db";
import { extractMemory, loadMemory, saveMemory } from "./memory";
import type { Finance } from "./finance";
import { queueOutbox } from "./outbox";
import { maybeAnswerAfford } from "./photo";
import { isRecallQuestion, recallAnswer } from "./recall";

const MENTION_ALIASES: Record<string, CharacterId> = {
  checking: "checking", check: "checking", bank: "checking",
  savings: "savings", saving: "savings", piggy: "savings",
  card: "card", credit: "card", creditcard: "card",
  carloan: "car_loan", car_loan: "car_loan", car: "car_loan", loan: "car_loan",
  ira: "ira", retirement: "ira",
  coach: "coach",
};

/**
 * "@savings how am I doing?" -> that character answers, with the @name removed from the question.
 * Only a leading @name counts, so an email address or "@" mid-sentence never reroutes a text.
 */
export function parseMention(text: string): { who: CharacterId; rest: string } | null {
  const m = text.trim().match(/^@\s*([a-z_]+(?:\s+loan)?)\b[\s,:-]*(.*)$/is);
  if (!m) return null;
  const who = MENTION_ALIASES[m[1].toLowerCase().replace(/\s+/g, "")];
  return who ? { who, rest: m[2].trim() } : null;
}

/** Who answers a question, by what it mentions. The Coach takes anything general. */
export function pickResponder(text: string): CharacterId {
  const t = text.toLowerCase();
  if (/\b(credit|card|apr|interest|utiliz)/.test(t)) return "card";
  if (/\b(car|loan|auto)\b/.test(t)) return "car_loan";
  if (/\b(ira|retire|retirement|401k|match)\b/.test(t)) return "ira";
  if (/\b(saving|savings|emergency fund|cushion|runway)\b/.test(t)) return "savings";
  if (/\b(checking|balance|afford|spend|rent|bill|paycheck|payday)\b/.test(t)) return "checking";
  return "coach";
}

export async function handleChat(
  deps: { db: Queryable; facts: () => Promise<FactsSnapshot>; userPhone: string; model?: (p: string) => Promise<string>; finance?: Finance },
  inbound: { id: number; text: string | null },
  now: Date,
): Promise<{ learned: number; responder: CharacterId | null }> {
  const text = inbound.text?.trim() ?? "";
  if (!text) return { learned: 0, responder: null };
  const base = { user_phone: deps.userPhone, reply_to: inbound.id, thread_key: `inbound:${inbound.id}`, priority: 1 as const, created_sim_at: now.toISOString() };

  // "Can I afford $40?" (or a price after a photo) is answered by P1's can_i_afford, not by the model.
  if (deps.finance && (await maybeAnswerAfford({ db: deps.db, finance: deps.finance, userPhone: deps.userPhone }, { id: inbound.id, text }, now)))
    return { learned: 0, responder: "checking" };

  // "What did we decide?" is answered from the record (last call + latest plan), never from the model.
  if (isRecallQuestion(text)) {
    const facts = await deps.facts();
    const answer = (await recallAnswer(deps.db, deps.userPhone, facts.timezone)) ?? "Nothing's been decided yet: no calls or plans on record. Text me any time you want the crew to weigh in.";
    await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:recall`, speaker: "coach", text: answer });
    return { learned: 0, responder: "coach" };
  }

  const learned = extractMemory(text);
  if (learned.length) {
    await saveMemory(deps.db, deps.userPhone, learned, now);
    await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:memory`, speaker: "coach", text: learned.map((l) => l.ack).join(" ") });
    return { learned: learned.length, responder: "coach" };
  }

  // "@savings ..." picks the speaker; otherwise route by topic. A bare "@savings" is a check-in.
  const mention = parseMention(text);
  const responder = mention?.who ?? pickResponder(text);
  const question = mention ? mention.rest || "How am I doing with you right now?" : text;
  const facts = await deps.facts();
  const goals = (await loadMemory(deps.db, deps.userPhone)).filter((m) => m.kind === "goal");
  const ask = mention
    ? `The user tagged you directly and asked: "${question}". Only you answer, in your own voice, from your account's point of view.`
    : `The user texted: "${question}". Answer them directly in character.`;
  const r = await speak(responder, facts, `${ask}${goals.length ? ` Their goals: ${JSON.stringify(goals.map((g) => g.value))}.` : ""}`, {
    model: deps.model,
    // Numbers the user typed themselves ("can I afford $40?") are fair to repeat back.
    extraSources: [...goals.map((g) => g.value), extractNumbers(text).flatMap((n) => (n.value != null ? [n.value] : []))],
  });
  await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:answer`, speaker: responder, text: r.text });
  return { learned: 0, responder };
}
