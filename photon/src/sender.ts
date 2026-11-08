import type { Db } from "./db.js";
import { simNow } from "./db.js";
import { formatMessage } from "./format.js";
import type { Target } from "./photon.js";

export type OutboxRow = {
  id: number;
  idempotency_key: string;
  user_phone: string;
  speaker: string;
  text: string;
  attachment: string | null;
  reply_to: number | null;
  reply_to_outbox: number | null;
  attempts: number;
  created_at: Date | string;
};

/**
 * The key Photon uses to drop duplicate sends. It must be the same for every retry of one outbox row,
 * but never repeat across rows, even after a demo reset restarts outbox ids and reuses P2's keys
 * (Photon remembers keys and rejects a reused one: "Idempotency-Key was reused for a different request").
 * The row's creation time makes it unique; the id and P2's key keep it readable in Photon's logs.
 */
export function photonKey(row: Pick<OutboxRow, "id" | "idempotency_key" | "created_at">): string {
  const t = new Date(row.created_at).getTime();
  return `outbox:${row.id}:${t}:${row.idempotency_key}`.slice(0, 200);
}

/** What the sender needs from Photon. Real functions in production, fakes in tests. */
export type Transport = {
  sendText(t: Target, text: string, key: string, parentMessageId?: string): Promise<{ id?: string } | unknown>;
  setTyping(t: Target, typing: boolean): Promise<boolean>;
  sendCard?(t: Target, userPhone: string, key: string): Promise<void>;
};

export const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the typing indicator shows before a message (real clock): longer messages "take longer
 * to type", short acknowledgments pop in fast. Never slow: capped at 2 s (1 s in demo mode).
 */
export function gapMs(text: string, demoMode: boolean): number {
  const n = text.length;
  return demoMode ? Math.min(1000, Math.max(300, 250 + 8 * n)) : Math.min(2000, Math.max(700, 500 + 15 * n));
}

/** After a crash, rows left in 'sending' go back to the queue. Idempotency keys make the resend safe. */
export async function recoverStuck(db: Db): Promise<void> {
  await db.query(`UPDATE outbox SET status = 'pending' WHERE status = 'sending'`);
}

/** Claim the next row: highest priority first, then oldest. One at a time. */
async function claimNext(db: Db): Promise<OutboxRow | undefined> {
  const r = await db.query<OutboxRow>(
    `UPDATE outbox SET status = 'sending', attempts = attempts + 1
     WHERE id = (SELECT id FROM outbox WHERE status = 'pending' ORDER BY priority DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, idempotency_key, user_phone, speaker, text, attachment, reply_to, reply_to_outbox, attempts, created_at`,
  );
  return r.rows[0];
}

/**
 * Send one pending outbox row if there is one. Returns what happened, for logs and tests.
 * - no conversation yet for that phone → 'held' (released when the user texts; Photon can't text first)
 * - success → 'sent'; failure → back to 'pending' until MAX_ATTEMPTS, then 'failed'
 */
export async function sendOne(
  db: Db,
  transport: Transport,
  opts: { wait?: (ms: number) => Promise<void> } = {},
): Promise<"idle" | "sent" | "held" | "retry" | "failed"> {
  const wait = opts.wait ?? sleep;
  const row = await claimNext(db);
  if (!row) return "idle";

  const space = (
    await db.query<{ space_id: string; agent_user_id: string }>(
      `SELECT space_id, agent_user_id FROM p3_photon_spaces WHERE user_phone = $1`,
      [row.user_phone],
    )
  ).rows[0];
  if (!space) {
    await db.query(
      `UPDATE outbox SET status = 'held', attempts = attempts - 1, last_error = 'user has not texted the line yet' WHERE id = $1`,
      [row.id],
    );
    return "held";
  }

  const target: Target = { spaceId: space.space_id, senderId: space.agent_user_id };
  try {
    // Thread under an earlier cast message (Card answering IRA), else under the user's message.
    let parent: string | undefined;
    if (row.reply_to_outbox) {
      parent =
        (
          await db.query<{ provider_msg_id: string | null }>(`SELECT provider_msg_id FROM p3_outbox_sends WHERE outbox_id = $1`, [
            row.reply_to_outbox,
          ])
        ).rows[0]?.provider_msg_id ?? undefined;
    }
    if (!parent && row.reply_to) {
      parent = (
        await db.query<{ provider_msg_id: string }>(`SELECT provider_msg_id FROM inbound_messages WHERE id = $1`, [row.reply_to])
      ).rows[0]?.provider_msg_id;
    }

    const { demoMode } = await simNow(db);
    await transport.setTyping(target, true);
    await wait(gapMs(row.text, demoMode));

    const key = photonKey(row);
    const res = (await transport.sendText(target, formatMessage(row.speaker, row.text), key, parent)) as { id?: string };
    if (row.attachment === "indicator_card" && transport.sendCard) {
      await transport.sendCard(target, row.user_phone, `${key}:card`);
    }

    await db.query(`UPDATE outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = $1`, [row.id]);
    await db.query(
      `INSERT INTO p3_outbox_sends (outbox_id, provider_msg_id) VALUES ($1, $2) ON CONFLICT (outbox_id) DO UPDATE SET provider_msg_id = EXCLUDED.provider_msg_id`,
      [row.id, res?.id ?? null],
    );
    return "sent";
  } catch (err) {
    const message = (err as Error)?.message?.slice(0, 500) ?? String(err);
    const giveUp = row.attempts >= MAX_ATTEMPTS;
    await db.query(`UPDATE outbox SET status = $2, last_error = $3 WHERE id = $1`, [row.id, giveUp ? "failed" : "pending", message]);
    if (!giveUp) await wait(1000 * 2 ** row.attempts); // backoff: 2s, 4s
    return giveUp ? "failed" : "retry";
  } finally {
    await transport.setTyping(target, false).catch(() => false);
  }
}

/** Drain the outbox forever, one message at a time. */
export async function runSender(db: Db, transport: Transport, log = console.log): Promise<never> {
  await recoverStuck(db);
  for (;;) {
    try {
      const result = await sendOne(db, transport);
      if (result !== "idle") log(`[sender] ${result}`);
      if (result === "idle" || result === "held") await sleep(500);
    } catch (err) {
      log(`[sender] loop error: ${(err as Error).message}`);
      await sleep(2000);
    }
  }
}
