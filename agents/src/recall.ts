// "What did we decide?" by text: answered from what was actually recorded, never from the model.
// Sources: the last call (P4's post-call webhook writes calls.summary and calls.decisions) and the latest proposal.
import type { Queryable } from "./db";

const RECALL = /\b(what\s+(did|have)\s+we\s+(decide|agree|say|settle)|what\s+was\s+(the|our)\s+(plan|decision|deal)|remind\s+me\s+(of\s+)?(the|our|what)|recap|what('s| is)\s+the\s+plan)\b/i;

export const isRecallQuestion = (text: string) => RECALL.test(text);

const STATUS_WORDS: Record<string, string> = {
  pending: "still waiting on your YES",
  accepted: "you said yes; I'm watching for the transfer",
  declined: "you said no, so nothing moved",
  expired: "it expired before you answered, so nothing moved",
  completed: "done, the transfer went through",
};

/** Builds the answer, or null if there is nothing on record yet. */
export async function recallAnswer(db: Queryable, userPhone: string, timezone: string): Promise<string | null> {
  const day = (v: unknown) => new Date(v as string).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timezone });

  const call = (
    await db.query<{ summary: string | null; decisions: unknown; ended_sim_at: unknown; direction: string }>(
      "SELECT summary, decisions, ended_sim_at, direction FROM calls WHERE user_phone = $1 AND summary IS NOT NULL ORDER BY COALESCE(ended_sim_at, started_sim_at) DESC NULLS LAST, id DESC LIMIT 1",
      [userPhone],
    )
  ).rows[0];
  const proposal = (
    await db.query<{ action_text: string; status: string; decided_sim_at: unknown; created_sim_at: unknown; channel: string | null }>(
      "SELECT action_text, status, decided_sim_at, created_sim_at, channel FROM proposals WHERE user_phone = $1 ORDER BY id DESC LIMIT 1",
      [userPhone],
    )
  ).rows[0];

  const parts: string[] = [];
  if (call?.summary) parts.push(`On our last call${call.ended_sim_at ? ` (${day(call.ended_sim_at)})` : ""}: ${call.summary.trim().replace(/\s+/g, " ").replace(/\.?$/, ".")}`);
  if (proposal)
    parts.push(
      `Latest plan: ${proposal.action_text}. Status: ${STATUS_WORDS[proposal.status] ?? proposal.status}${proposal.channel === "voice" ? " (decided on the phone)" : ""}.`,
    );
  return parts.length ? parts.join(" ") : null;
}
