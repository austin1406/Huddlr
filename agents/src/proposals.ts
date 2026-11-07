// ProposalService: the only code that changes a proposal. Text replies, voice (through P1's accept_proposal
// wrapper), and P1's transfer watcher all end up here, so the rules live in one place.
//
// Each state change is a single conditional UPDATE (… WHERE status = 'pending' …), so two YES messages
// racing each other can't both win, and no transaction is needed.
import {
  PROPOSAL_TTL_MS,
  ProposalRow,
  toCents,
  toProposalSummary,
  type Channel,
  type CreateProposalInput,
  type ProposalFailReason,
  type ProposalResult,
  type ProposalService,
  type ProposalSummary,
} from "../../contracts/src";
import type { Queryable } from "./db";

const COLS = `id, user_phone, plan, from_account, to_account, amount_cents, action_text, source_event_id, status, channel,
  created_sim_at, expires_at, decided_sim_at, completed_sim_at, completed_txn_id`;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/** DB row (numbers may come back as strings, timestamps as Date) -> ProposalRow. */
function toRow(r: Record<string, unknown>): ProposalRow {
  return ProposalRow.parse({
    ...r,
    id: Number(r.id),
    amount_cents: Number(r.amount_cents),
    plan: typeof r.plan === "string" ? JSON.parse(r.plan) : r.plan,
    created_sim_at: iso(r.created_sim_at),
    expires_at: iso(r.expires_at),
    decided_sim_at: iso(r.decided_sim_at),
    completed_sim_at: iso(r.completed_sim_at),
  });
}

const ok = (row: ProposalRow): ProposalResult => ({ ok: true, status: row.status, reason: null, proposal: toProposalSummary(row) });
const fail = (reason: ProposalFailReason, row: ProposalRow | null): ProposalResult => ({
  ok: false,
  status: row?.status ?? null,
  reason,
  proposal: row ? toProposalSummary(row) : null,
});

/** Why a change didn't apply, given the row as it is now. */
function whyNot(row: ProposalRow | null, now: Date): ProposalFailReason {
  if (!row) return "not_found";
  if (row.status === "accepted") return "already_accepted";
  if (row.status === "completed") return "already_completed";
  if (row.status === "expired" || (row.status === "pending" && new Date(row.expires_at) <= now)) return "expired";
  return "not_pending";
}

/**
 * @param now simulated clock (SimClock.now / readClock). Called on every operation so fast-forward applies at once.
 */
export function makeProposalService(db: Queryable, now: () => Date | Promise<Date>): ProposalService & {
  get(id: number): Promise<ProposalRow | null>;
  expireStale(): Promise<number>;
} {
  const get = async (id: number) => {
    if (!Number.isInteger(id) || id <= 0) return null;
    const r = await db.query(`SELECT ${COLS} FROM proposals WHERE id = $1`, [id]);
    return r.rows[0] ? toRow(r.rows[0]) : null;
  };

  /** Pending proposals whose time ran out become expired. */
  const expireStale = async (t?: Date) => {
    const at = t ?? (await now());
    const r = await db.query(`UPDATE proposals SET status = 'expired', decided_sim_at = $1 WHERE status = 'pending' AND expires_at <= $1 RETURNING id`, [at]);
    return r.rows.length;
  };

  /** One conditional update; returns the result or explains why nothing changed. */
  const transition = async (id: number, sql: string, params: unknown[], t: Date): Promise<ProposalResult> => {
    if (!Number.isInteger(id) || id <= 0) return fail("not_found", null);
    const r = await db.query(sql, params);
    if (r.rows[0]) {
      // The user answered (or the money moved): an emergency call that hasn't started yet is no longer needed.
      await db.query("UPDATE call_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE proposal_id = $1 AND status = 'pending'", [id]);
      return ok(toRow(r.rows[0]));
    }
    const row = await get(id);
    const reason = whyNot(row, t);
    if (reason === "expired" && row?.status === "pending") {
      await expireStale(t);
      return fail("expired", await get(id));
    }
    return fail(reason, row);
  };

  return {
    get,
    expireStale: () => expireStale(),

    async getPending(userPhone: string): Promise<ProposalSummary | null> {
      await expireStale();
      const r = await db.query(`SELECT ${COLS} FROM proposals WHERE user_phone = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`, [userPhone]);
      return r.rows[0] ? toProposalSummary(toRow(r.rows[0])) : null;
    },

    async create(input: CreateProposalInput): Promise<ProposalResult> {
      const t = await now();
      // One pending proposal per user: a new plan replaces the old one.
      await db.query(`UPDATE proposals SET status = 'expired', decided_sim_at = $2 WHERE user_phone = $1 AND status = 'pending'`, [input.userPhone, t]);
      const r = await db.query(
        `INSERT INTO proposals (user_phone, plan, from_account, to_account, amount_cents, action_text, source_event_id, created_sim_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
        [input.userPhone, JSON.stringify(input.plan), input.from, input.to, toCents(input.amount), input.actionText,
          input.sourceEventId ?? null, t, new Date(t.getTime() + PROPOSAL_TTL_MS)],
      );
      return ok(toRow(r.rows[0]));
    },

    async accept(id: number, via: Channel): Promise<ProposalResult> {
      const t = await now();
      return transition(id,
        `UPDATE proposals SET status = 'accepted', channel = $2, decided_sim_at = $3
         WHERE id = $1 AND status = 'pending' AND expires_at > $3 RETURNING ${COLS}`, [id, via, t], t);
    },

    async decline(id: number, via: Channel): Promise<ProposalResult> {
      const t = await now();
      return transition(id,
        `UPDATE proposals SET status = 'declined', channel = $2, decided_sim_at = $3
         WHERE id = $1 AND status = 'pending' AND expires_at > $3 RETURNING ${COLS}`, [id, via, t], t);
    },

    async expire(id: number): Promise<ProposalResult> {
      const t = await now();
      return transition(id,
        `UPDATE proposals SET status = 'expired', decided_sim_at = $2 WHERE id = $1 AND status = 'pending' RETURNING ${COLS}`, [id, t], t);
    },

    /**
     * P1's watcher saw the transfer. Accepted -> completed. A pending one also completes: the user may move the
     * money without texting YES first, and that still counts. Same txn id twice is a harmless repeat.
     */
    async markCompleted(id: number, txnId: string): Promise<ProposalResult> {
      const t = await now();
      return transition(id,
        `UPDATE proposals SET status = 'completed', completed_sim_at = $2, completed_txn_id = $3,
           decided_sim_at = COALESCE(decided_sim_at, $2)
         WHERE id = $1 AND status IN ('pending', 'accepted') RETURNING ${COLS}`, [id, t, txnId], t);
    },
  };
}
