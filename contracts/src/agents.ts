import { z } from "zod";
import { AccountId, CharacterId, isoDate, isoDateTime, money } from "./common";
import { ProposalStatus, type ProposalSummary, type Shortfall } from "./facts";
import { Plan } from "./plan";

/**
 * P2 (agents) contracts. Two layers:
 *  - Database rows (p2_agents.sql): snake_case, integer cents, numeric ids. P3 and P4 read/write some tables directly.
 *  - HTTP API (ProposalService): camelCase JSON like P1's tools. Dollars in, dollars out.
 * Every calendar timestamp (*_sim_at, expires_at, due_at) comes from SimClock.now(). Delivery timestamps use the real clock.
 */

/** Who wrote a message. CharacterId plus "system" for plain notices (expiry, errors). */
export const Speaker = z.union([CharacterId, z.literal("system")]);
export type Speaker = z.infer<typeof Speaker>;

export const Channel = z.enum(["text", "voice"]);
export type Channel = z.infer<typeof Channel>;

const phone = z.string().regex(/^\+\d{8,15}$/, "expected E.164, e.g. +12145550123");
const id = z.number().int().positive();
const cents = z.number().int();

/** Proposals expire this long after creation, on SimClock.now(). */
export const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

export const toCents = (dollars: number): number => Math.round(dollars * 100);
export const toDollars = (c: number): number => c / 100;

// ---------------------------------------------------------------- outbox (P2 writes, P3 sends)

export const OutboxStatus = z.enum(["pending", "sending", "sent", "failed", "held"]);

/** 2 = emergency (ignores quiet hours and the cap), 1 = reply to the user, 0 = proactive. */
export const OutboxPriority = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/** What P2 inserts. P3 formats it as "<emoji> <name>: <text>" using cast.json and sends one at a time. */
export const OutboxInsert = z.object({
  /** Unique; a retry with the same key never double-sends. e.g. "evt:<eventId>:card". */
  idempotency_key: z.string().min(1),
  user_phone: phone,
  speaker: Speaker,
  /** Body only, no "Name:" prefix. */
  text: z.string().min(1),
  attachment: z.literal("indicator_card").nullable().optional(),
  /** inbound_messages.id to thread under, if Photon supports it. */
  reply_to: id.nullable().optional(),
  /** Groups one debate or digest, e.g. "evt:<eventId>". */
  thread_key: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
  proposal_id: id.nullable().optional(),
  priority: OutboxPriority.default(0),
  created_sim_at: isoDateTime,
});
export type OutboxInsert = z.infer<typeof OutboxInsert>;

export const OutboxRow = OutboxInsert.extend({
  id,
  status: OutboxStatus,
  attempts: z.number().int().min(0),
  last_error: z.string().nullable(),
  created_at: isoDateTime,
  sent_at: isoDateTime.nullable(),
});
export type OutboxRow = z.infer<typeof OutboxRow>;

// ---------------------------------------------------------------- inbound (P3 writes, P2 reads)

export const InboundInsert = z.object({
  /** Photon message id. Unique: duplicate webhooks are dropped. */
  provider_msg_id: z.string().min(1),
  user_phone: phone,
  text: z.string().nullable(),
  attachment_ids: z.array(z.string()).default([]),
  /** Local paths of stored images (P3, H7-8). */
  attachment_paths: z.array(z.string()).default([]),
  reply_to_provider_msg_id: z.string().nullable().optional(),
  received_sim_at: isoDateTime,
});
export type InboundInsert = z.infer<typeof InboundInsert>;

export const InboundRow = InboundInsert.extend({
  id,
  received_at: isoDateTime,
  /** Set by P2 once handled. */
  processed_at: isoDateTime.nullable(),
});
export type InboundRow = z.infer<typeof InboundRow>;

// ---------------------------------------------------------------- proposals (only ProposalService writes)

export const ProposalRow = z.object({
  id,
  user_phone: phone,
  /** P1's Plan stored verbatim (camelCase). */
  plan: Plan,
  from_account: AccountId,
  to_account: AccountId,
  amount_cents: cents.positive(),
  /** One-line action the Coach asked for, e.g. "Move $143 from Savings to Checking". */
  action_text: z.string(),
  source_event_id: z.string().nullable(),
  status: ProposalStatus,
  channel: Channel.nullable(),
  created_sim_at: isoDateTime,
  expires_at: isoDateTime,
  decided_sim_at: isoDateTime.nullable(),
  completed_sim_at: isoDateTime.nullable(),
  /** Transfer id P1's watcher matched. */
  completed_txn_id: z.string().nullable(),
});
export type ProposalRow = z.infer<typeof ProposalRow>;

/** Row -> P1's read-only ProposalSummary (string id, dollars), for facts and the finance tools. */
export function toProposalSummary(row: ProposalRow): ProposalSummary {
  return {
    id: String(row.id),
    actionText: row.action_text,
    amount: toDollars(row.amount_cents),
    from: row.from_account,
    to: row.to_account,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

export const ProposalFailReason = z.enum(["not_found", "not_pending", "expired", "already_accepted", "already_completed"]);
export type ProposalFailReason = z.infer<typeof ProposalFailReason>;

/**
 * Result of every state change. Wrong-state is a normal outcome (ok:false), never an exception,
 * so a duplicate YES or a late reply is handled, not crashed on. Shape matches P1's AcceptProposalResponse.
 */
export const ProposalResult = z.object({
  ok: z.boolean(),
  status: ProposalStatus.nullable(),
  reason: ProposalFailReason.nullable(),
  proposal: z.custom<ProposalSummary>().nullable(),
});
export type ProposalResult = z.infer<typeof ProposalResult>;

export const CreateProposalInput = z.object({
  userPhone: phone,
  plan: Plan,
  from: AccountId,
  to: AccountId,
  amount: money.positive(),
  actionText: z.string().min(1),
  sourceEventId: z.string().nullable().optional(),
});
export type CreateProposalInput = z.infer<typeof CreateProposalInput>;

/**
 * The ONLY code path that changes a proposal. Text replies, voice (through P1's accept_proposal
 * wrapper), and P1's transfer watcher all call it. Nobody else writes the proposals table.
 *
 * Transitions: pending -> accepted | declined | expired;  accepted -> completed.
 * - At most one pending proposal per user; create() expires an older one first.
 * - accept() after expires_at marks it expired and returns { ok:false, reason:"expired" }.
 * - accept() twice returns { ok:false, reason:"already_accepted" } and sends nothing new.
 */
export interface ProposalService {
  getPending(userPhone: string): Promise<ProposalSummary | null>;
  create(input: CreateProposalInput): Promise<ProposalResult>;
  accept(id: number, via: Channel): Promise<ProposalResult>;
  decline(id: number, via: Channel): Promise<ProposalResult>;
  expire(id: number): Promise<ProposalResult>;
  markCompleted(id: number, txnId: string): Promise<ProposalResult>;
}

/**
 * Agents service HTTP API. All require the x-huddlr-secret header (TOOL_AUTH_HEADER).
 * Full URL = PUBLIC_BASE_URL + AGENTS_BASE_PATH + path, e.g. https://<domain>/agents/proposals/7/accept.
 * Ids in paths are the numeric database ids; P1's finance wrapper converts its string ids with Number(id).
 */
/** Caddy routes /agents/* to the agents service (port 5000), so every path below lives under this prefix. */
export const AGENTS_BASE_PATH = "/agents";

export const AGENT_ENDPOINTS = {
  health: { method: "GET", path: "/health" },
  getPending: { method: "GET", path: "/proposals/pending" }, // ?userPhone=+1...  (defaults to DEMO_USER_PHONE)
  create: { method: "POST", path: "/proposals" }, // body CreateProposalInput
  accept: { method: "POST", path: "/proposals/:id/accept" }, // body { via }
  decline: { method: "POST", path: "/proposals/:id/decline" }, // body { via }
  expire: { method: "POST", path: "/proposals/:id/expire" },
  complete: { method: "POST", path: "/proposals/:id/complete" }, // body { txnId }  (P1 watcher)
  reset: { method: "POST", path: "/reset" }, // reset-agents, used by reset-all
} as const;

export const GetPendingResponse = z.object({ proposal: z.custom<ProposalSummary>().nullable() });
export const DecideRequest = z.object({ via: Channel });
export const CompleteRequest = z.object({ txnId: z.string().min(1) });

// ---------------------------------------------------------------- call_requests (P2 writes, P4 places the call)

export const CallRequestType = z.enum(["emergency", "monthly_recap"]);
export const CallRequestStatus = z.enum(["pending", "calling", "answered", "no_answer", "busy", "failed", "cancelled"]);

/** Copy of P1's Shortfall, in cents, so the call script needs nothing else. */
export const CallShortfall = z.object({ amount_cents: cents, date: isoDate, account: AccountId });
export type CallShortfall = z.infer<typeof CallShortfall>;

export function toCallShortfall(s: Shortfall): CallShortfall {
  return { amount_cents: toCents(s.amount), date: s.firstNegativeDate, account: s.accountId };
}

export const CallRequestInsert = z.object({
  user_phone: phone,
  type: CallRequestType,
  proposal_id: id.nullable(),
  shortfall: CallShortfall.nullable(),
  /** Short opener for the voice agent, built from facts only. */
  script_hint: z.string().nullable(),
  created_sim_at: isoDateTime,
});
export type CallRequestInsert = z.infer<typeof CallRequestInsert>;

export const CallRequestRow = CallRequestInsert.extend({
  id,
  status: CallRequestStatus,
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type CallRequestRow = z.infer<typeof CallRequestRow>;

// ---------------------------------------------------------------- memory (shared by text and voice)

export const MemoryMessage = z.object({
  user_phone: phone,
  channel: Channel,
  direction: z.enum(["in", "out"]),
  speaker: z.union([Speaker, z.literal("user")]),
  text: z.string(),
  outbox_id: id.nullable().optional(),
  inbound_id: id.nullable().optional(),
  call_id: id.nullable().optional(),
  created_sim_at: isoDateTime,
});
export type MemoryMessage = z.infer<typeof MemoryMessage>;

export const MemoryFact = z.object({
  user_phone: phone,
  kind: z.enum(["goal", "preference", "note"]),
  /** e.g. "goal:vacation", "pref:no_texts_before_9". Unique per user. */
  key: z.string().min(1),
  value: z.unknown(),
  source: z.enum(["text", "voice", "seed"]),
  created_sim_at: isoDateTime,
  updated_sim_at: isoDateTime,
});
export type MemoryFact = z.infer<typeof MemoryFact>;

/** P4's post-call webhook writes this. */
export const CallRecord = z.object({
  user_phone: phone,
  provider_call_id: z.string().nullable(),
  direction: z.enum(["inbound", "outbound"]),
  call_request_id: id.nullable(),
  summary: z.string().nullable(),
  decisions: z.array(z.object({ proposal_id: id, decision: z.enum(["accepted", "declined"]) })).default([]),
  started_sim_at: isoDateTime.nullable(),
  ended_sim_at: isoDateTime.nullable(),
  duration_ms: z.number().int().nullable(),
});
export type CallRecord = z.infer<typeof CallRecord>;

export const FollowUp = z.object({
  user_phone: phone,
  kind: z.enum(["proposal_reminder", "escalation_check", "goal_checkin", "digest"]),
  proposal_id: id.nullable(),
  /** Simulated time. */
  due_at: isoDateTime,
  payload: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["pending", "done", "cancelled"]),
  created_sim_at: isoDateTime,
});
export type FollowUp = z.infer<typeof FollowUp>;

// ---------------------------------------------------------------- reply rule

/** Only an unambiguous yes accepts. Everything else (mixed, unclear, a question) is not approval. */
export const ReplyIntent = z.enum(["yes", "no", "unclear"]);
export type ReplyIntent = z.infer<typeof ReplyIntent>;
