// The first time a phone ever texts the line, the Coach introduces the crew before anything else is answered.
// Built from cast.json so names and emoji always match what the phone shows. Once per phone (until a reset).
import { cast } from "./character";
import type { Queryable } from "./db";
import { queueOutbox } from "./outbox";

export function welcomeText(): string {
  const accounts = cast.filter((c) => c.id !== "coach").map((c) => `${c.emoji} ${c.name}`);
  const coach = cast.find((c) => c.id === "coach")!;
  return `Meet your money: ${accounts.slice(0, -1).join(", ")} and ${accounts.at(-1)} each watch one account. ${coach.emoji} ${coach.name} always gives the final plan. Ask anything, or @mention one of them (like @Savings).`;
}

/** Queues the welcome if this inbound row is the phone's first text ever. Returns true if it queued one. */
export async function maybeWelcome(db: Queryable, row: { id: number; user_phone: string }, now: Date): Promise<boolean> {
  const earlier = await db.query("SELECT 1 FROM inbound_messages WHERE user_phone = $1 AND id < $2 LIMIT 1", [row.user_phone, row.id]);
  if (earlier.rows.length) return false;
  const id = await queueOutbox(db, {
    idempotency_key: `welcome:${row.user_phone}`, user_phone: row.user_phone, speaker: "coach", text: welcomeText(),
    reply_to: row.id, thread_key: `inbound:${row.id}`, priority: 1, created_sim_at: now.toISOString(),
  });
  return id != null;
}
