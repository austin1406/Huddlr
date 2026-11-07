import type { Db } from "./db.js";
import { simNow } from "./db.js";
import { attachmentIds, type InboundMessage } from "./message.js";

/**
 * Save one human message for P2's agents and remember how to reach this person.
 * Returns the inbound row id, or null if we already had it (duplicate delivery).
 */
export async function saveInbound(db: Db, m: InboundMessage): Promise<number | null> {
  const phone = m.sentBy?.handle;
  if (!phone || !m.receivedBy?.id) throw new Error("inbound message missing sender handle or agent id");

  await db.query(
    `INSERT INTO p3_photon_spaces (user_phone, space_id, agent_user_id, agent_handle, last_inbound_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (user_phone) DO UPDATE SET space_id = EXCLUDED.space_id, agent_user_id = EXCLUDED.agent_user_id,
       agent_handle = EXCLUDED.agent_handle, last_inbound_at = CURRENT_TIMESTAMP`,
    [phone, m.space.id, m.receivedBy.id, m.receivedBy.handle ?? null],
  );

  // The user has now texted us, so anything we were holding for them can go out.
  await db.query(`UPDATE outbox SET status = 'pending', last_error = NULL WHERE user_phone = $1 AND status = 'held'`, [phone]);

  const { now } = await simNow(db);
  const text = m.content?.type === "text" && typeof m.content.text === "string" ? m.content.text : null;
  const r = await db.query<{ id: number }>(
    `INSERT INTO inbound_messages (provider_msg_id, user_phone, text, attachment_ids, received_sim_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_msg_id) DO NOTHING
     RETURNING id`,
    [m.id, phone, text, attachmentIds(m), now],
  );
  return r.rows[0]?.id ?? null;
}

/** Photon told us one of our sends reached the phone. */
export async function markDelivered(db: Db, providerMsgId: string): Promise<void> {
  await db.query(`UPDATE p3_outbox_sends SET delivered_at = CURRENT_TIMESTAMP WHERE provider_msg_id = $1`, [providerMsgId]);
}
