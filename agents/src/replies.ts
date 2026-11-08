// Handles a text the user sent (an inbound_messages row written by P3's webhook).
// If a proposal is pending and the text is a reply to it, it goes through ProposalService.
// Everything else is handed back as "chat" for the character agents (H8-9).
import type { InboundRow, ProposalService, ProposalSummary } from "../../contracts/src";
import type { Queryable } from "./db";
import { queueOutbox } from "./outbox";
import { isRecallQuestion } from "./recall";
import { classifyReply } from "./reply";

export type HandleResult =
  | { kind: "duplicate" }
  | { kind: "chat" }
  | { kind: "accepted" | "declined" | "expired" | "clarify" | "noop"; proposalId: number };

/** "so what should i do", "what now", "what's the bottom line", "tldr", "i don't know what to do". */
export const isBottomLineQuestion = (text: string) =>
  /\b(what (?:should|do|can) i (?:do|pick|choose)|what(?:'s| is)? (?:the )?(?:bottom line|move|play|takeaway|plan)|what now|now what|so what\b(?! about)|tl;?dr|bottom line|what do you (?:want|need) me to do|(?:don'?t|dont) know what to do|which (?:one|should i))\b/i.test(text);

/**
 * Short texts with a pending plan are treated as answers to it ("maybe", "ok wait"); longer ones are conversation.
 * An @-mention or a question is never an answer: "@savings how am I doing" must reach Savings even while a plan
 * waits. Safe either way, because chat never approves anything; only a clear YES does.
 */
export const looksLikeAnswer = (text: string) => {
  const t = text.trim().replace(/^[​-‍﻿\s]+/, "");
  if (/^[@＠]/.test(t)) return false;
  if (/\?\s*$/.test(t) && !/^(yes|yeah|yep|ok|okay|sure|no|nope|maybe|wait|hm+|huh)\b/i.test(t)) return false;
  if (/^(how|what|what's|whats|why|where|when|which|who|can|could|should|would|is|am|are|do|does|did|will|tell me|show me|explain)\b/i.test(t)) return false;
  // "so what should i do", "ok so what now", "i don't know what to do": asking for the bottom line, not answering.
  if (isBottomLineQuestion(t)) return false;
  return t.split(/\s+/).length <= 6;
};

export async function handleInbound(
  db: Queryable,
  proposals: ProposalService,
  row: Pick<InboundRow, "id" | "user_phone" | "text">,
  now: Date,
): Promise<HandleResult> {
  // Claim the row once. A redelivered webhook or a second worker gets "duplicate".
  const claimed = await db.query("UPDATE inbound_messages SET processed_at = $2 WHERE id = $1 AND processed_at IS NULL RETURNING id", [row.id, now]);
  if (!claimed.rows[0]) return { kind: "duplicate" };

  const text = row.text ?? "";
  await db.query(
    `INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at)
     VALUES ($1, 'text', 'in', 'user', $2, $3, $4)`,
    [row.user_phone, text, row.id, now],
  );

  const pending = await proposals.getPending(row.user_phone);
  const intent = classifyReply(text);
  const sayAbout = (id: number) => (key: string, body: string) =>
    queueOutbox(db, {
      idempotency_key: `inbound:${row.id}:${key}`, user_phone: row.user_phone, speaker: "coach", text: body,
      reply_to: row.id, thread_key: `proposal:${id}`, proposal_id: id, priority: 1, created_sim_at: now.toISOString(),
    });

  if (!pending) {
    // A YES to a plan that just ran out of time: say so instead of going quiet.
    if (intent === "yes") {
      const expired = await db.query<{ id: number }>(
        `SELECT id FROM proposals WHERE user_phone = $1 AND status = 'expired' AND decided_sim_at > $2::timestamptz - interval '24 hours'
         ORDER BY id DESC LIMIT 1`,
        [row.user_phone, now],
      );
      const id = expired.rows[0] ? Number(expired.rows[0].id) : null;
      if (id != null) {
        await sayAbout(id)("expired", EXPIRED_TEXT);
        return { kind: "expired", proposalId: id };
      }
    }
    return { kind: "chat" };
  }
  if (intent === "unclear" && (isRecallQuestion(text) || !looksLikeAnswer(text))) return { kind: "chat" };

  const id = Number(pending.id);
  const say = sayAbout(id);

  if (intent === "yes") {
    const r = await proposals.accept(id, "text");
    if (r.ok) {
      await say("accepted", acceptedText(pending));
      return { kind: "accepted", proposalId: id };
    }
    if (r.reason === "expired") {
      await say("expired", EXPIRED_TEXT);
      return { kind: "expired", proposalId: id };
    }
    return { kind: "noop", proposalId: id }; // e.g. already accepted: no second message
  }

  if (intent === "no") {
    const r = await proposals.decline(id, "text");
    if (r.ok) await say("declined", "No problem, I dropped that plan. Nothing moves.");
    return { kind: r.ok ? "declined" : "noop", proposalId: id };
  }

  await say("clarify", `Just to be safe, I only act on a clear YES. Reply YES to: ${pending.actionText}. Or NO to skip it.`);
  return { kind: "clarify", proposalId: id };
}

const EXPIRED_TEXT = "That plan expired before your YES came in, so I didn't lock it in. I'll put together a fresh one.";

/** The agents never move money: the user makes the transfer, and P1's watcher marks it completed. */
export function acceptedText(p: ProposalSummary): string {
  return `Locked in: ${p.actionText}. Make the transfer in your bank app when you're ready and I'll watch for it.`;
}
