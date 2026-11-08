// A text that isn't an answer to a proposal: remember any goal or preference in it, then let the right
// character answer (one speaker, grounded like everything else).
import type { CharacterId, FactsSnapshot, Plan } from "../../contracts/src";
import { lowestBreakdown, speak } from "./character";
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

/**
 * "I got a $600 bonus, what should I do?" -> { amount: 600, label: "a bonus" }. Needs exactly one dollar amount and
 * either a windfall word (bonus, refund, gift, ...) or a "what should I do with" question.
 */
export function parseWindfall(text: string): { amount: number; label: string } | null {
  const t = text.toLowerCase();
  const kind =
    t.match(/\b(bonus|tax refund|refund|tax return|inheritance|gift|raise|commission|side hustle|freelance|cash back|winnings|windfall|birthday money)\b/)?.[1] ?? null;
  const asks = /\bwhat should i do\b|\bwhere should (it|i put)\b|\bhow should i (use|spend|split)\b|\bwhat do i do with\b|\bshould i (save|invest|pay)\b/.test(t);
  if (!kind && !(asks && /\b(extra|got|have|received|made|earned)\b/.test(t))) return null;
  // "$600", or a bare "600" when a windfall word makes clear it's money.
  const nums = extractNumbers(text);
  let money = nums.filter((n) => n.kind === "money");
  if (!money.length && kind) money = nums.filter((n) => n.kind === "number" && (n.value ?? 0) >= 20);
  if (money.length !== 1 || !money[0].value || money[0].value <= 0) return null;
  return { amount: money[0].value, label: kind ? `the user got ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}` : "the user has extra money" };
}

/** "why am I moving…", "what about the 600?", "so where do I put it??": a question about what was just proposed. */
export function isFollowUp(text: string): boolean {
  return /\b(why|what about|where (do|should|does|did) i|where'?d|so where|which one|confus\w*|explain|instead|huh|wait|what does (that|this) mean|i don'?t get|how (did|come|is that|so)|i thought|that'?s (not|wrong)|doesn'?t (add up|make sense)|what do you mean|wdym|(come|get|got) (that|it|\$?[\d,.]+) from|from where)\b|\?\?/i.test(text);
}

const ACCOUNT_NAMES: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Car Loan", ira: "IRA" };

/** The pending proposal, with its plan spelled out in words (built from the plan's own numbers). */
async function pendingPlan(db: Queryable, phone: string) {
  const r = await db.query<{ action_text: string; source_event_id: string | null; plan: Plan | string }>(
    "SELECT action_text, source_event_id, plan FROM proposals WHERE user_phone = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [phone],
  );
  const row = r.rows[0];
  if (!row) return null;
  const plan = (typeof row.plan === "string" ? JSON.parse(row.plan) : row.plan) as Plan;
  const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const windfall = row.source_event_id?.startsWith("chat_windfall_");
  const split = plan.lines
    .map((l) => {
      const to = ACCOUNT_NAMES[String(l.destination)] ?? String(l.destination);
      if (windfall && l.destination === "checking") return `keep ${usd(l.amount)} in Checking (${l.reasonCode.replace(/_/g, " ")}; the new money is already there)`;
      return `${usd(l.amount)} to ${to} (${l.reasonCode.replace(/_/g, " ")})`;
    })
    .join("; ");
  // For the Coach's "who is right" rule (it follows the first line): for a bonus, lead with where money moves.
  const coachPlan = windfall ? { ...plan, lines: [...plan.lines.filter((l) => l.destination !== "checking"), ...plan.lines.filter((l) => l.destination === "checking")] } : plan;
  return { actionText: row.action_text, source: row.source_event_id, plan, coachPlan, planAmount: plan.amount, split };
}

/** The last few texts both ways (not counting this one), as "you: …" / "Savings: …" lines, plus every number in them. */
async function recentConversation(db: Queryable, phone: string, inboundId: number, limit = 8) {
  const r = await db.query<{ direction: string; speaker: string; text: string }>(
    "SELECT direction, speaker, text FROM memory_messages WHERE user_phone = $1 AND channel = 'text' AND (inbound_id IS NULL OR inbound_id <> $2) ORDER BY id DESC LIMIT $3",
    [phone, inboundId, limit],
  );
  const rows = r.rows.reverse();
  const lines = rows.map((m) => (m.direction === "in" ? `you: ${m.text}` : `${ACCOUNT_NAMES[m.speaker] ?? (m.speaker === "coach" ? "Coach" : m.speaker)}: ${m.text}`));
  const numbers = rows.flatMap((m) => extractNumbers(m.text).flatMap((n) => (n.value != null ? [n.value] : [])));
  // Who answered most recently: "where did I get 419 from?" is a question for them.
  const lastOut = [...rows].reverse().find((m) => m.direction === "out");
  const lastSpeaker = lastOut && (lastOut.speaker in ACCOUNT_NAMES || lastOut.speaker === "coach") ? (lastOut.speaker as CharacterId) : null;
  return { lines, numbers, lastSpeaker };
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
  deps: {
    db: Queryable; facts: () => Promise<FactsSnapshot>; userPhone: string; model?: (p: string) => Promise<string>; finance?: Finance;
    /** Runs the group debate for a windfall (debate.ts runWindfall). Without it, the question gets one answer. */
    windfall?: (ask: { inboundId: number; text: string; amount: number; label: string }, now: Date) => Promise<{ speakers: CharacterId[] }>;
  },
  inbound: { id: number; text: string | null },
  now: Date,
): Promise<{ learned: number; responder: CharacterId | null; debate?: CharacterId[] }> {
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

  const pending = await pendingPlan(deps.db, deps.userPhone);

  // "I got a $600 bonus, what should I do?" gets the whole crew: a debate and a plan to say YES to.
  // An @-mention means the user wants one voice, so it skips this. Asking again about the same bonus while its plan
  // is still waiting ("so where do I put the 600??") is a follow-up: the Coach explains that plan instead of re-running it.
  const windfall = !parseMention(text) && deps.windfall ? parseWindfall(text) : null;
  const sameWindfall = windfall && pending?.source?.startsWith("chat_windfall_") && pending.planAmount === windfall.amount;
  if (windfall && deps.windfall && !sameWindfall) {
    const r = await deps.windfall({ inboundId: inbound.id, text, ...windfall }, now);
    return { learned: 0, responder: "coach", debate: r.speakers };
  }

  const learned = extractMemory(text);
  if (learned.length) {
    await saveMemory(deps.db, deps.userPhone, learned, now);
    await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:memory`, speaker: "coach", text: learned.map((l) => l.ack).join(" ") });
    return { learned: learned.length, responder: "coach" };
  }

  // Who answers, in order:
  //   "@savings …"                          -> that character (a bare "@savings" is a check-in)
  //   the same bonus again                  -> the Coach, explaining the plan that's waiting
  //   a follow-up ("where did 419 come from?", "why?", "I thought I had 2500") -> whoever answered last
  //   a follow-up with a plan waiting and no recent answer -> the Coach
  //   anything else                         -> by topic
  const mention = parseMention(text);
  const recent = await recentConversation(deps.db, deps.userPhone, inbound.id);
  const followUp = !mention && (sameWindfall || isFollowUp(text));
  const responder: CharacterId = mention?.who
    ?? (sameWindfall ? "coach" : followUp && recent.lastSpeaker ? recent.lastSpeaker : followUp && pending ? "coach" : pickResponder(text));
  // The Coach explaining the waiting plan is held to the debate rules (exact YES line, nobody wrongly "right").
  const explainingPlan = responder === "coach" && followUp && pending != null;
  const question = mention ? mention.rest || "How am I doing with you right now?" : text;
  const facts = await deps.facts();
  const goals = (await loadMemory(deps.db, deps.userPhone)).filter((m) => m.kind === "goal");
  const ask = mention
    ? `The user tagged you directly and asked: "${question}". Only you answer, in your own voice, from your account's point of view.`
    : followUp && !explainingPlan
      ? `The user texted: "${question}". They're asking about the conversation below, most likely your last message. Explain plainly where its numbers come from, step by step, using your KEY NUMBERS (for Checking: the balance now, the bills before the low point, everyday spending, and the lowest point). If your last message was a "can I afford" answer, its lowest balance already has that purchase taken out: say the lowest point without it, then that the purchase takes it to the number you gave. If they mixed up two numbers, say which is which using ALL BALANCES. Answer the question; skip your usual pitch this time.`
      : `The user texted: "${question}". Answer them directly in character.`;
  const balances = facts.accounts
    .map((a) => `${ACCOUNT_NAMES[a.id] ?? a.name} ${a.kind === "credit_card" || a.kind === "car_loan" ? "owed " : ""}$${a.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    .join(", ");
  const context = [
    ...(recent.lines.length ? [`RECENT CONVERSATION (oldest first):`, ...recent.lines] : []),
    ...(followUp ? [`ALL BALANCES: ${balances}.`] : []),
    ...(pending ? [`THE PLAN WAITING FOR THEIR YES: "${pending.actionText}". The full plan: ${pending.split}.`] : []),
    ...(recent.lines.length || pending
      ? [`Answer their latest text as part of this conversation, not from scratch. If they're confused about the plan, explain plainly what it does and why, with its numbers. Never contradict the waiting plan or invent a different one.`]
      : []),
  ].join("\n");
  const r = await speak(responder, facts, `${ask}${goals.length ? ` Their goals: ${JSON.stringify(goals.map((g) => g.value))}.` : ""}${context ? `\n${context}` : ""}`, {
    model: deps.model,
    // The Coach explaining the waiting plan is held to the same code-enforced rules as in a debate: the exact YES line,
    // and nobody is called "right" who didn't speak just now (no "Savings is right because…" out of nowhere).
    ...(explainingPlan && pending ? { plan: pending.coachPlan, ask: pending.actionText, heard: [] } : {}),
    // Numbers the user typed themselves ("can I afford $40?"), and numbers already said in this conversation
    // (each was grounded when it was sent), are fair to repeat back.
    extraSources: [
      ...goals.map((g) => g.value),
      extractNumbers(text).flatMap((n) => (n.value != null ? [n.value] : [])),
      recent.numbers,
      ...(pending ? [pending.plan] : []),
      ...(followUp ? [facts.accounts] : []),
      ...(responder === "checking" ? [lowestBreakdown(facts)] : []),
    ],
  });
  await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:answer`, speaker: responder, text: r.text });
  return { learned: 0, responder };
}
