// A text that isn't an answer to a proposal: remember any goal or preference in it, then let the right
// character answer (one speaker, grounded like everything else).
import type { CharacterId, FactsSnapshot } from "../../contracts/src";
import { speak } from "./character";
import { extractNumbers } from "./checker";
import type { Queryable } from "./db";
import { extractMemory, loadMemory, saveMemory } from "./memory";
import { queueOutbox } from "./outbox";

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
  deps: { db: Queryable; facts: () => Promise<FactsSnapshot>; userPhone: string; model?: (p: string) => Promise<string> },
  inbound: { id: number; text: string | null },
  now: Date,
): Promise<{ learned: number; responder: CharacterId | null }> {
  const text = inbound.text?.trim() ?? "";
  if (!text) return { learned: 0, responder: null };
  const base = { user_phone: deps.userPhone, reply_to: inbound.id, thread_key: `inbound:${inbound.id}`, priority: 1 as const, created_sim_at: now.toISOString() };

  const learned = extractMemory(text);
  if (learned.length) {
    await saveMemory(deps.db, deps.userPhone, learned, now);
    await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:memory`, speaker: "coach", text: learned.map((l) => l.ack).join(" ") });
    return { learned: learned.length, responder: "coach" };
  }

  const responder = pickResponder(text);
  const facts = await deps.facts();
  const goals = (await loadMemory(deps.db, deps.userPhone)).filter((m) => m.kind === "goal");
  const r = await speak(responder, facts, `The user texted: "${text}". Answer them directly in character.${goals.length ? ` Their goals: ${JSON.stringify(goals.map((g) => g.value))}.` : ""}`, {
    model: deps.model,
    // Numbers the user typed themselves ("can I afford $40?") are fair to repeat back.
    extraSources: [...goals.map((g) => g.value), extractNumbers(text).flatMap((n) => (n.value != null ? [n.value] : []))],
  });
  await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:answer`, speaker: responder, text: r.text });
  return { learned: 0, responder };
}
