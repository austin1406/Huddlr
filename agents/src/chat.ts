// A text that isn't an answer to a proposal: remember any goal or preference in it, then let the right
// character answer (one speaker, grounded like everything else).
import type { CharacterId, FactsSnapshot, Plan, ProposalService } from "../../contracts/src";
import { proposalFromPlan, type Waiting } from "./debate";
import { scheduleProposalFollowUps } from "./followups";
import { allMovesText, leadWith, loadPriorities, mergePriorities, NAMES, parsePriorities, priorityAck, savePriorities } from "./priorities";
import { accountSummary, isSummaryQuestion } from "./summary";
import { describeLoan, handleLoanReport, loadReportedLoans, loanSources, totalLoansOwed } from "./loans";
import { bottomLine } from "./bottomline";
import { isBottomLineQuestion } from "./replies";
import { doLine, explainTemplate, lowestBreakdown, speak } from "./character";
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
  carloan: "car_loan", car_loan: "car_loan", car: "car_loan", loan: "car_loan", loans: "car_loan", autoloan: "car_loan",
  studentloan: "car_loan", student: "car_loan", mortgage: "car_loan", debtloan: "car_loan",
  ira: "ira", retirement: "ira",
  coach: "coach",
};

/**
 * "@savings how am I doing?" -> that character answers, with the @name removed from the question.
 * Only a leading @name counts, so an email address or "@" mid-sentence never reroutes a text.
 */
export function parseMention(text: string): { who: CharacterId; rest: string } | null {
  // Tolerates an invisible character before the @ and the full-width ＠ some keyboards produce.
  const m = text.trim().replace(/^[​-‍﻿]+/, "").match(/^[@＠]\s*([a-z_]+(?:\s+loan)?)\b[\s,:-]*(.*)$/is);
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

const ACCOUNT_NAMES: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Loan", ira: "IRA" };

/** The pending proposal, with its plan spelled out in words (built from the plan's own numbers). */
async function pendingPlan(db: Queryable, phone: string) {
  const r = await db.query<{ action_text: string; source_event_id: string | null; plan: Plan | string; to_account: string }>(
    "SELECT action_text, source_event_id, plan, to_account FROM proposals WHERE user_phone = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1",
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
  // For the Coach's "who is right" rule (it follows the first line): lead with the line the YES moves.
  const yesLine = plan.lines.find((l) => l.destination === row.to_account && l.amount > 0) ?? null;
  const coachPlan = leadWith(plan, yesLine);
  return { actionText: row.action_text, to: row.to_account, source: row.source_event_id, plan, coachPlan, planAmount: plan.amount, split };
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
  return { lines, numbers, lastSpeaker, lastText: lastOut?.text ?? null };
}

/** "explain…", "what does APR mean", "what's utilization", "I don't get it", "in simple words". */
export function isExplainRequest(text: string): boolean {
  return /\b(explain|eli5|in simple (?:words|terms)|simpler|break (?:it|that) down|i don'?t (?:get|understand)|what (?:does|do) (?:\w+\s){0,4}mean|what(?:'s| is| are) (?:an? |the |my )?(?:apr|interest rate|utili[sz]ation|runway|cushion|buffer|employer match|match|shortfall|safe to spend|must-pay bills|essentials|ira|emergency fund|minimum payment))\b/i.test(text);
}

/** Who should explain a money word: the character it belongs to. */
export function explainer(text: string): CharacterId | null {
  const t = text.toLowerCase();
  if (/\b(apr|interest|utili[sz]ation|credit|card|minimum payment)\b/.test(t)) return "card";
  if (/\b(employer match|match|ira|retirement|401k)\b/.test(t)) return "ira";
  if (/\b(cushion|runway|emergency fund|essentials|must-pay|savings)\b/.test(t)) return "savings";
  if (/\b(shortfall|buffer|safe to spend|payday|lowest|checking|negative)\b/.test(t)) return "checking";
  if (/\b(car loan|car payment|loans?|principal|payoff|pay off|amortiz\w*|mortgage|student loans?)\b/.test(t)) return "car_loan";
  if (/\b(plan|yes|proposal)\b/.test(t)) return "coach";
  return null;
}

/** Plain meanings the model can lean on, so "explain" answers are simple and right. */
const GLOSSARY = [
  `APR: the yearly interest rate on what you owe; each month the card charges about one twelfth of it on the balance.`,
  `Credit utilization: how much of your card limit you're using; staying under 30% helps your credit score.`,
  `Savings cushion: how long your savings would cover your must-pay bills if your income stopped.`,
  `Buffer: the small amount you like to keep in Checking so it never hits zero.`,
  `Employer match: your job adds money to your IRA when you put money in; any match you don't claim is free money left behind.`,
  `Shortfall: Checking would dip below zero before your next paycheck.`,
  `Safe to spend: what you can spend before payday and still keep your buffer.`,
  `Must-pay bills: rent, utilities, phone, the loan payment and the card minimum.`,
  `Principal: the part of the loan you still owe. Each payment covers that month's interest first; the rest lowers the principal.`,
].join(" ");

/** Who answers a question, by what it mentions. The Coach takes anything general. */
export function pickResponder(text: string): CharacterId {
  const t = text.toLowerCase();
  if (/\b(credit|card|apr|interest|utiliz)/.test(t)) return "card";
  if (/\b(car|loans?|auto|mortgage|student loans?|principal|payoff)\b/.test(t)) return "car_loan";
  if (/\b(ira|retire|retirement|401k|match)\b/.test(t)) return "ira";
  if (/\b(saving|savings|emergency fund|cushion|runway)\b/.test(t)) return "savings";
  if (/\b(checking|balance|afford|spend|rent|bill|paycheck|payday)\b/.test(t)) return "checking";
  return "coach";
}

export async function handleChat(
  deps: {
    db: Queryable; facts: () => Promise<FactsSnapshot>; userPhone: string; model?: (p: string) => Promise<string>; finance?: Finance;
    /** Re-points a waiting plan when the user states priorities. Without it, priorities are saved and confirmed only. */
    proposals?: ProposalService;
    /** "What should I do?" roundtable (debate.ts runOptions): every account's option, then the Coach's bottom line. */
    options?: (ask: { inboundId: number; text: string; waiting: Waiting | null }, now: Date) => Promise<{ speakers: CharacterId[] }>;
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

  // "So what should I do?": each account with a stake gives its option, then the Coach's bottom line (built in code:
  // the move, why, and the rest for later). Without the roundtable wired in, just the Coach's bottom line.
  // ("I got a $600 bonus, what should I do?" is a new question about new money: that's the bonus debate below.)
  if (isBottomLineQuestion(text) && !parseWindfall(text) && (!parseMention(text) || parseMention(text)!.who === "coach")) {
    const waiting = pending ? { actionText: pending.actionText, to: pending.to, plan: pending.plan, windfall: pending.source?.startsWith("chat_windfall_") ?? false } : null;
    if (deps.options) {
      const r = await deps.options({ inboundId: inbound.id, text, waiting }, now);
      return { learned: 0, responder: "coach", debate: r.speakers };
    }
    await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:bottomline`, speaker: "coach", text: bottomLine(await deps.facts(), waiting) });
    return { learned: 0, responder: "coach" };
  }

  // "Give me a summary of my account": every account in one message, built in code. No YES invite beyond
  // naming the plan that's already waiting.
  if (isSummaryQuestion(text) && (!parseMention(text) || parseMention(text)!.who === "coach")) {
    const summary = accountSummary(await deps.facts(), await loadPriorities(deps.db, deps.userPhone), pending?.actionText ?? null, await loadReportedLoans(deps.db, deps.userPhone));
    await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:summary`, speaker: "coach", text: summary });
    return { learned: 0, responder: "coach" };
  }

  // "Prioritize my IRA over savings", "pay off the card first", "don't touch my savings": save it, confirm it, and
  // re-point the plan that's waiting (if any) so its YES moves the user's top priority first.
  const change = parsePriorities(parseMention(text)?.rest || text);
  if (change) {
    const merged = mergePriorities(await loadPriorities(deps.db, deps.userPhone), change);
    await savePriorities(deps.db, deps.userPhone, merged, now);
    let reply = priorityAck(change);
    if (pending && deps.proposals && !change.clear) {
      const windfallPlan = pending.source?.startsWith("chat_windfall_") ?? false;
      const next = proposalFromPlan(pending.plan, merged, { windfall: windfallPlan });
      const top = change.first?.[0];
      const missing = top && !pending.plan.lines.some((l) => l.destination === top && l.amount > 0);
      if (next && next.actionText !== pending.actionText) {
        const created = await deps.proposals.create({ userPhone: deps.userPhone, plan: pending.plan, ...next, sourceEventId: pending.source });
        if (created.proposal) await scheduleProposalFollowUps(deps.db, { userPhone: deps.userPhone, proposalId: Number(created.proposal.id), now, emergency: false });
        reply += ` I've updated the plan: ${doLine(next.actionText)}`;
      } else if (missing) {
        reply += ` The plan that's waiting doesn't put anything in ${NAMES[top]}; it goes first next time there's money to place. Still to do: ${doLine(pending.actionText)}`;
      } else {
        reply += ` Your plan already starts there: ${doLine(pending.actionText)}`;
      }
    }
    await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:priorities`, speaker: "coach", text: reply });
    return { learned: 1, responder: "coach" };
  }

  // "I took a loan out for tuition", "it's 10000, add that in", "5%, $150 a month": the Loan character saves it,
  // breaks it down when it has the rate and payment, and asks for what's missing. Built in code, exact.
  if (!parseMention(text) || parseMention(text)!.who === "car_loan") {
    const reply = await handleLoanReport(deps.db, deps.userPhone, parseMention(text)?.rest || text, await deps.facts(), now);
    if (reply) {
      await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:loan`, speaker: "car_loan", text: reply });
      return { learned: 1, responder: "car_loan" };
    }
  }

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
  // "Explain APR", "what does that mean", "in simple words": the character the word belongs to explains it simply,
  // or whoever just spoke if it's about their last message.
  const explain = isExplainRequest(mention?.rest || text);
  const responder: CharacterId = mention?.who
    ?? (sameWindfall ? "coach"
      : explain && explainer(text) ? explainer(text)!
      : followUp && recent.lastSpeaker ? recent.lastSpeaker
      : followUp && pending ? "coach"
      : pickResponder(text));
  // The Coach explaining the waiting plan is held to the debate rules (exact YES line, nobody wrongly "right").
  const explainingPlan = responder === "coach" && followUp && pending != null && (!explain || explainer(text) === "coach" || !explainer(text));
  const question = mention ? mention.rest || "How am I doing with you right now?" : text;
  const facts = await deps.facts();
  const goals = (await loadMemory(deps.db, deps.userPhone)).filter((m) => m.kind === "goal");
  const ask = explain && !explainingPlan
    ? `The user asked: "${question}". Explain it in simple words, like you're texting a friend who's new to money: up to 3 short sentences, no jargon, and use one of their real numbers from KEY NUMBERS as the example. If it's about something said earlier in the conversation below, explain that, and don't repeat it word for word: say it a new, simpler way, like an everyday comparison. Plain meanings you can use: ${GLOSSARY}`
    : mention
    ? `The user tagged you directly and asked: "${question}". Only you answer, in your own voice, from your account's point of view.`
    : followUp && !explainingPlan
      ? `The user texted: "${question}". They're asking about the conversation below, most likely your last message. Explain plainly where its numbers come from, step by step, using your KEY NUMBERS (for Checking: the balance now, the bills before the low point, everyday spending, and the lowest point). If your last message was a "can I afford" answer, its lowest balance already has that purchase taken out: say the lowest point without it, then that the purchase takes it to the number you gave. If they mixed up two numbers, say which is which using ALL BALANCES. Answer the question; skip your usual pitch this time.`
      : `The user texted: "${question}". Answer them directly in character.`;
  const reported = responder === "car_loan" ? await loadReportedLoans(deps.db, deps.userPhone) : [];
  const balances = facts.accounts
    .map((a) => `${ACCOUNT_NAMES[a.id] ?? a.name} ${a.kind === "credit_card" || a.kind === "car_loan" ? "owed " : ""}$${a.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    .join(", ");
  const context = [
    ...(recent.lines.length ? [`RECENT CONVERSATION (oldest first):`, ...recent.lines] : []),
    ...(followUp ? [`ALL BALANCES: ${balances}.`] : []),
    ...(responder === "car_loan" && reported.length
      ? [`OTHER LOANS THE USER TOLD YOU ABOUT (not in the bank data): ${reported.map((l) => describeLoan(l, facts.localDate)).join("; ")}. All loans together: $${totalLoansOwed(facts, reported).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} owed. Mention them when they matter.`]
      : []),
    ...(pending ? [`THE PLAN (the user makes the move themselves in their bank app; you never ask for a YES): "${doLine(pending.actionText)}" The full plan: ${pending.split}.`] : []),
    ...(recent.lines.length || pending
      ? [`Answer their latest text as part of this conversation, not from scratch. If they're confused about the plan, explain plainly what it does and why, with its numbers. Never contradict the waiting plan or invent a different one.`]
      : []),
  ].join("\n");
  const r = await speak(responder, facts, `${ask}${goals.length ? ` Their goals: ${JSON.stringify(goals.map((g) => g.value))}.` : ""}${context ? `\n${context}` : ""}`, {
    model: deps.model,
    // "What does that mean?" must rephrase the last message, not repeat it (code-enforced, one retry).
    ...((explain || followUp) && recent.lastText ? { avoidRepeating: [recent.lastText] } : {}),
    // Loan, asked how things stand, must count the loans the user told us about: the total across all of them.
    ...(responder === "car_loan" && !explain && reported.some((l) => l.owed != null)
      ? { mustMention: [{ text: `$${totalLoansOwed(facts, reported).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, why: "the total owed on all their loans, including the ones they told you about" }] }
      : {}),
    // The Coach explaining the waiting plan is held to the same code-enforced rules as in a debate: the exact YES line,
    // and nobody is called "right" who didn't speak just now (no "Savings is right because…" out of nowhere).
    ...(explainingPlan && pending ? { plan: pending.coachPlan, ask: allMovesText(pending.coachPlan, pending.coachPlan.lines[0] ?? null, { windfall: pending.source?.startsWith("chat_windfall_") ?? false }) ?? pending.actionText, heard: [] } : {}),
    // Numbers the user typed themselves ("can I afford $40?"), and numbers already said in this conversation
    // (each was grounded when it was sent), are fair to repeat back.
    extraSources: [
      ...goals.map((g) => g.value),
      extractNumbers(text).flatMap((n) => (n.value != null ? [n.value] : [])),
      recent.numbers,
      ...(pending ? [pending.plan] : []),
      ...(followUp ? [facts.accounts] : []),
      ...(responder === "checking" ? [lowestBreakdown(facts)] : []),
      ...(responder === "car_loan" ? [...loanSources(reported, facts.localDate), totalLoansOwed(facts, reported)] : []),
    ],
  });
  // An "explain" whose Gemini answer couldn't be sent gets a plain explanation, not the character's usual line.
  let text2 = explain && !explainingPlan && r.source === "template" ? explainTemplate(responder, facts) : r.text;
  // The Loan character's fallback still counts the loans the user told us about.
  if (responder === "car_loan" && r.source === "template" && reported.some((l) => l.owed != null))
    text2 += ` With your other loans, you owe $${totalLoansOwed(facts, reported).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} on loans in total.`;
  await queueOutbox(deps.db, { ...base, idempotency_key: `inbound:${inbound.id}:answer`, speaker: responder, text: text2 });
  return { learned: 0, responder };
}
