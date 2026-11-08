// Writing to the outbox is the only way the agents talk to the user. P3's sender delivers the rows.
// Every message is also saved to memory_messages so text and voice share one history.
import { OutboxInsert } from "../../contracts/src";
import type { Queryable } from "./db";

/**
 * Inserts one message. Returns the new id, or null if this idempotency key was already queued.
 * The NOT EXISTS check skips the insert entirely for a known key, so pollers that re-queue the same message
 * (the digest runs every few seconds) don't burn an outbox id each time. ON CONFLICT still covers a race.
 */
export async function queueOutbox(db: Queryable, input: OutboxInsert): Promise<number | null> {
  const m = OutboxInsert.parse(input);
  const r = await db.query<{ id: number }>(
    `INSERT INTO outbox (idempotency_key, user_phone, speaker, text, attachment, reply_to, reply_to_outbox, thread_key, event_id, proposal_id, priority, created_sim_at)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::bigint, $12::bigint, $7::text, $8::text, $9::bigint, $10::smallint, $11::timestamptz
     WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE idempotency_key = $1::text)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [m.idempotency_key, m.user_phone, m.speaker, m.text, m.attachment ?? null, m.reply_to ?? null, m.thread_key ?? null,
      m.event_id ?? null, m.proposal_id ?? null, m.priority, m.created_sim_at, m.reply_to_outbox ?? null],
  );
  const id = r.rows[0]?.id;
  if (id == null) return null;
  await db.query(
    `INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, outbox_id, created_sim_at)
     VALUES ($1, 'text', 'out', $2, $3, $4, $5)`,
    [m.user_phone, m.speaker, m.text, Number(id), m.created_sim_at],
  );
  return Number(id);
}
