// Writes to P2's tables (contracts/p2_agents.sql): calls, outbox, memory_messages; reads memory_facts goals.
// Without DATABASE_URL the service still runs and logs what it would have written.
import pg from "pg";
import { env } from "./env";
import type { ParsedCall } from "./postCall";
import { fallbackText, type CallRequest, type CallRequestStore } from "./outbound";

const pool = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 4 }) : null;

export const hasDatabase = pool != null;

export async function demoMode(): Promise<boolean> {
  if (!pool) return false;
  try {
    const r = await pool.query<{ demo_mode: boolean }>("SELECT demo_mode FROM sim_state LIMIT 1");
    return Boolean(r.rows[0]?.demo_mode);
  } catch {
    return false;
  }
}

const REQ_COLS = "id, user_phone, type, proposal_id, shortfall, script_hint";
type ReqRow = { id: string | number; user_phone: string; type: CallRequest["type"]; proposal_id: string | number | null; shortfall: CallRequest["shortfall"]; script_hint: string | null };
const toReq = (r: ReqRow): CallRequest => ({ ...r, id: Number(r.id), proposal_id: r.proposal_id == null ? null : Number(r.proposal_id) });

/** Anything with pg's query shape: a Pool, a PoolClient, or PGlite in tests. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

async function queueOutbox(db: Queryable, key: string, phone: string, text: string, priority: number, simNowAt: Date, threadKey: string, proposalId: number | null = null) {
  await db.query(
    `INSERT INTO outbox (idempotency_key, user_phone, speaker, text, thread_key, proposal_id, priority, created_sim_at)
     VALUES ($1, $2, 'coach', $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, phone, text, threadKey, proposalId, priority, simNowAt],
  );
}

export function pgCallRequestStore(): CallRequestStore {
  if (!pool) throw new Error("DATABASE_URL is required for outbound calls");
  return makeCallRequestStore(pool as unknown as Queryable);
}

export function makeCallRequestStore(db: Queryable): CallRequestStore {
  return {
    async claimNext({ includeRecap }) {
      const r = await db.query<ReqRow>(
        `UPDATE call_requests SET status = 'calling', updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM call_requests
           WHERE status = 'pending' AND (type = 'emergency' OR $1)
           ORDER BY (type = 'emergency') DESC, id
           LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING ${REQ_COLS}`,
        [includeRecap],
      );
      return r.rows[0] ? toReq(r.rows[0]) : null;
    },
    async setStatus(id, status) {
      await db.query("UPDATE call_requests SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id, status]);
    },
    async stale(olderThanMs) {
      const r = await db.query<ReqRow>(
        `SELECT ${REQ_COLS} FROM call_requests
         WHERE status = 'calling' AND updated_at < CURRENT_TIMESTAMP - ($1 || ' milliseconds')::interval`,
        [String(olderThanMs)],
      );
      return r.rows.map(toReq);
    },
    async queueFallbackText(req, text, simNowAt) {
      // Emergency fallbacks get priority 2 so P3's sender ignores quiet hours for them.
      await queueOutbox(db, `callreq:${req.id}:fallback`, req.user_phone, text, req.type === "emergency" ? 2 : 0, simNowAt, `callreq:${req.id}`, req.proposal_id);
    },
  };
}

/** Marks a call request after ElevenLabs reports the call never connected, and texts instead. */
export async function recordCallFailure(callRequestId: number, outcome: "no_answer" | "busy" | "failed"): Promise<boolean> {
  if (!pool) return false;
  const r = await pool.query<ReqRow>(
    `UPDATE call_requests SET status = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'calling' RETURNING ${REQ_COLS}`,
    [callRequestId, outcome],
  );
  if (!r.rows[0]) return false;
  const req = toReq(r.rows[0]);
  await pgCallRequestStore().queueFallbackText(req, fallbackText(req, outcome), await simNow());
  return true;
}

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
  const client = await pool.connect();
  try {
    return await saveCallTx(client as unknown as Queryable, call, recap, now);
  } finally {
    client.release();
  }
}

/** The transaction behind saveCall, on any pg-shaped connection (PGlite in tests). */
export async function saveCallTx(client: Queryable, call: ParsedCall, recap: string, now: Date): Promise<{ saved: boolean; callId?: number }> {
  const offsetMs = now.getTime() - Date.now();
  const startedSim = call.startedAt ? new Date(call.startedAt.getTime() + offsetMs) : null;
  const endedSim = startedSim && call.durationMs != null ? new Date(startedSim.getTime() + call.durationMs) : now;
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: number }>(
      `INSERT INTO calls (user_phone, provider_call_id, direction, call_request_id, summary, decisions, started_sim_at, ended_sim_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider_call_id) DO NOTHING RETURNING id`,
      [call.userPhone, call.providerCallId, call.direction, call.callRequestId, call.summary, JSON.stringify(call.decisions), startedSim, endedSim, call.durationMs],
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
    // Outbound call from a call request: record whether they picked up.
    let request: CallRequest | null = null;
    if (call.callRequestId != null) {
      const r = await client.query<ReqRow>(
        `UPDATE call_requests SET status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status IN ('pending', 'calling') RETURNING ${REQ_COLS}`,
        [call.callRequestId, call.answered ? "answered" : "no_answer"],
      );
      request = r.rows[0] ? toReq(r.rows[0]) : null;
    }
    if (call.answered) {
      await queueOutbox(client, `call:${call.providerCallId}:recap`, call.userPhone, recap, 1, now, `call:${call.providerCallId}`);
    } else if (request) {
      // Nobody spoke (voicemail or rang out): text instead of a recap.
      await queueOutbox(client, `callreq:${request.id}:fallback`, request.user_phone, fallbackText(request, "no_answer"),
        request.type === "emergency" ? 2 : 0, now, `callreq:${request.id}`, request.proposal_id);
    }
    await client.query("COMMIT");
    return { saved: true, callId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}
