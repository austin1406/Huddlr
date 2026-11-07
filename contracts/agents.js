// P2 contracts: message shapes and the ProposalService interface. Additive changes only.
// Plain ESM + JSDoc so every service (Node) can import it without a build step.
// Tables live in contracts/p2_agents.sql.

/** Cast ids. P3 formats outbox rows as "<emoji> <name>: <text>" using contracts/cast.json. */
export const SPEAKERS = Object.freeze(['checking', 'savings', 'card', 'car_loan', 'ira', 'coach', 'system']);

export const ATTACHMENTS = Object.freeze(['indicator_card']);

export const PROPOSAL_STATUS = Object.freeze(['pending', 'accepted', 'declined', 'expired', 'completed']);

/** Proposals expire this long after creation, measured on the shared now(). */
export const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

export const CALL_REQUEST_TYPES = Object.freeze(['emergency', 'monthly_recap']);

/**
 * Row P2 writes to `outbox`. P3 sends it; P2 never talks to Photon directly.
 * @typedef {Object} OutboxRow
 * @property {string} idempotency_key   unique, e.g. "evt:<event_id>:<speaker>"
 * @property {string} user_phone        E.164
 * @property {string} speaker           one of SPEAKERS
 * @property {string} text              body only, no "Name:" prefix
 * @property {'indicator_card'|null} [attachment]
 * @property {number|null} [reply_to]   inbound_messages.id
 * @property {string|null} [thread_key]
 * @property {string|null} [event_id]
 * @property {number|null} [proposal_id]
 * @property {0|1|2} [priority]         2 emergency, 1 reply, 0 proactive
 */

/**
 * Row P3's webhook writes to `inbound_messages`.
 * @typedef {Object} InboundMessage
 * @property {number} id
 * @property {string} provider_msg_id   Photon id, unique (duplicate protection)
 * @property {string} user_phone
 * @property {string|null} text
 * @property {string[]} attachment_ids
 * @property {string[]} attachment_paths
 * @property {string|null} reply_to_provider_msg_id
 * @property {string} received_sim_at   ISO, from now()
 */

/**
 * @typedef {Object} Proposal
 * @property {number} id
 * @property {string} user_phone
 * @property {Array<Object>} plan        P1's plan shape, stored verbatim
 * @property {string} from_account
 * @property {string} to_account
 * @property {number} amount_cents
 * @property {string|null} source_event_id
 * @property {'pending'|'accepted'|'declined'|'expired'|'completed'} status
 * @property {'text'|'voice'|null} channel
 * @property {string} created_sim_at
 * @property {string} expires_at
 * @property {string|null} decided_sim_at
 * @property {string|null} completed_sim_at
 * @property {string|null} completed_txn_id
 */

/**
 * Result of every state-changing call. Never throws for "wrong state"; returns ok:false instead,
 * so a duplicate YES or a late reply is a normal outcome, not an error.
 * @typedef {Object} ProposalResult
 * @property {boolean} ok
 * @property {Proposal|null} proposal
 * @property {'not_found'|'not_pending'|'expired'|'already_accepted'|'already_completed'|null} reason
 */

/**
 * The ONLY code path that changes a proposal. Text replies, voice (P4 via accept_proposal),
 * and P1's transfer watcher all go through it. Nobody else writes the `proposals` table.
 *
 * HTTP (served by agents/, on PUBLIC_BASE_URL, shared-secret header `x-huddlr-secret`):
 *   GET  /proposals/pending?user_phone=+1...      -> { proposal: Proposal|null }   (expires stale ones first)
 *   POST /proposals                               body {user_phone, plan, from_account, to_account, amount_cents, source_event_id?}
 *   POST /proposals/:id/accept                    body {channel: 'text'|'voice'}  -> ProposalResult
 *   POST /proposals/:id/decline                   body {channel}                  -> ProposalResult
 *   POST /proposals/:id/expire                                                    -> ProposalResult
 *   POST /proposals/:id/complete                  body {txn_id}                   -> ProposalResult  (P1 watcher)
 *
 * Transitions: pending -> accepted | declined | expired;  accepted -> completed.
 * accept on an expired-by-time proposal marks it expired and returns {ok:false, reason:'expired'}.
 * accept twice returns {ok:false, reason:'already_accepted'} (idempotent, no second message).
 *
 * @typedef {Object} ProposalService
 * @property {(userPhone: string) => Promise<Proposal|null>} getPending
 * @property {(input: {user_phone: string, plan: Array<Object>, from_account: string, to_account: string, amount_cents: number, source_event_id?: string}) => Promise<ProposalResult>} create
 * @property {(id: number, channel: 'text'|'voice') => Promise<ProposalResult>} accept
 * @property {(id: number, channel: 'text'|'voice') => Promise<ProposalResult>} decline
 * @property {(id: number) => Promise<ProposalResult>} expire
 * @property {(id: number, txnId: string) => Promise<ProposalResult>} markCompleted
 */

/**
 * Row P2 writes to `call_requests`; P4 polls `status='pending'` and places the call.
 * @typedef {Object} CallRequest
 * @property {string} user_phone
 * @property {'emergency'|'monthly_recap'} type
 * @property {number|null} proposal_id
 * @property {{amount_cents: number, date: string, account: string}|null} shortfall  copy of P1's flag
 * @property {string|null} script_hint
 */
