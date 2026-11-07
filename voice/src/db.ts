// Writes to P2's tables (contracts/p2_agents.sql): calls, outbox, memory_messages; reads memory_facts goals.
// Without DATABASE_URL the service still runs and logs what it would have written.
import pg from "pg";
import { env } from "./env";
import type { ParsedCall } from "./postCall";

const pool = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 4 }) : null;

/**
 * Simulated now() = real time + sim_state.offset_seconds (P1's clock rule).
 * Falls back to real time if the table isn't there yet.
 */
export async function simNow(): Promise<Date> {
  if (!pool) return new Date();
  try {
    const r = await pool.query<{ offset_seconds: number }>("SELECT offset_seconds FROM sim_state LIMIT 1");
    return new Date(Date.now() + (r.rows[0]?.offset_seconds ?? 0) * 1000);
  } catch {
    return new Date();
  }
}

export async function loadGoals(userPhone: string): Promise<{ label: string; target?: number; saved?: number }[]> {
  if (!pool) return [];
  try {
    const r = await pool.query<{ key: string; value: { label?: string; target?: number; saved?: number } }>(
      "SELECT key, value FROM memory_facts WHERE user_phone = $1 AND kind = 'goal' ORDER BY updated_sim_at DESC LIMIT 5",
      [userPhone],
    );
    return r.rows.map((row) => ({ label: row.value.label ?? row.key.replace(/^goal:/, ""), target: row.value.target, saved: row.value.saved }));
  } catch {
    return [];
  }
}

/** Saves the call, its transcript, and the recap. Idempotent on the ElevenLabs conversation id. */
export async function saveCall(call: ParsedCall, recap: string): Promise<{ saved: boolean; callId?: number }> {
  if (!pool) {
    console.log("[voice] no DATABASE_URL, would save", { call: call.providerCallId, decisions: call.decisions, recap });
    return { saved: false };
  }
  const now = await simNow();
  const offsetMs = now.getTime() - Date.now();
  const startedSim = call.startedAt ? new Date(call.startedAt.getTime() + offsetMs) : null;
  const endedSim = startedSim && call.durationMs != null ? new Date(startedSim.getTime() + call.durationMs) : now;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: number }>(
      `INSERT INTO calls (user_phone, provider_call_id, direction, summary, decisions, started_sim_at, ended_sim_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider_call_id) DO NOTHING RETURNING id`,
      [call.userPhone, call.providerCallId, call.direction, call.summary, JSON.stringify(call.decisions), startedSim, endedSim, call.durationMs],
    );
    const callId = ins.rows[0]?.id;
    if (callId == null) {
      await client.query("ROLLBACK");
      return { saved: false }; // already processed (ElevenLabs retried the webhook)
    }
    for (const t of call.transcript) {
      await client.query(
        `INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, call_id, created_sim_at)
         VALUES ($1, 'voice', $2, $3, $4, $5, $6)`,
        [call.userPhone, t.speaker === "user" ? "in" : "out", t.speaker, t.text, callId, endedSim],
      );
    }
    await client.query(
      `INSERT INTO outbox (idempotency_key, user_phone, speaker, text, thread_key, priority, created_sim_at)
       VALUES ($1, $2, 'coach', $3, $4, 1, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [`call:${call.providerCallId}:recap`, call.userPhone, recap, `call:${call.providerCallId}`, now],
    );
    await client.query("COMMIT");
    return { saved: true, callId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
