-- P2 (agents) tables. Postgres. Additive changes only once merged.
-- Every calendar timestamp below (created_sim_at, expires_at, due_at, ...) is set from the shared now()
-- (real time + sim_state.offset_seconds). Delivery timestamps (sent_at, attempts) use the real clock.

-- Inbound: P3's webhook writes these; P2 consumes them.
CREATE TABLE IF NOT EXISTS inbound_messages (
  id                BIGSERIAL PRIMARY KEY,
  provider_msg_id   TEXT UNIQUE NOT NULL,        -- Photon message id (duplicate protection)
  user_phone        TEXT NOT NULL,
  text              TEXT,
  attachment_ids    TEXT[] NOT NULL DEFAULT '{}',-- Photon attachment ids
  attachment_paths  TEXT[] NOT NULL DEFAULT '{}',-- local stored image paths (P3, H7-8)
  reply_to_provider_msg_id TEXT,
  received_sim_at   TIMESTAMPTZ NOT NULL,        -- now()
  received_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at      TIMESTAMPTZ                  -- set by P2 when handled
);
CREATE INDEX IF NOT EXISTS inbound_unprocessed_idx ON inbound_messages (processed_at) WHERE processed_at IS NULL;

-- Outbox: the only way agents talk to the user. P3's sender drains it one row at a time.
CREATE TABLE IF NOT EXISTS outbox (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,          -- e.g. 'evt:<event_id>:<speaker>' so a retry never double-sends
  user_phone      TEXT NOT NULL,                 -- E.164
  speaker         TEXT NOT NULL,                 -- CharacterId (checking | savings | card | car_loan | ira | coach) or system
  text            TEXT NOT NULL,                 -- body only; P3 formats as "<emoji> <Name>: <text>"
  attachment      TEXT CHECK (attachment IN ('indicator_card')),   -- nullable
  reply_to        BIGINT REFERENCES inbound_messages(id),           -- nullable; threaded reply if Photon supports it
  thread_key      TEXT,                          -- groups one debate/digest (e.g. 'evt:<event_id>')
  event_id        TEXT,                          -- P1 FinanceEvent.id this reacts to, nullable
  proposal_id     BIGINT,                        -- proposals.id this mentions, nullable
  priority        SMALLINT NOT NULL DEFAULT 0,   -- 2 = emergency (ignores quiet hours), 1 = reply, 0 = proactive
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sending','sent','failed','held')),
  attempts        SMALLINT NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_sim_at  TIMESTAMPTZ NOT NULL,          -- now()
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (status, priority DESC, id);

-- Proposals: written ONLY through ProposalService (P2). P1 and P4 call the endpoints, never the table.
CREATE TABLE IF NOT EXISTS proposals (
  id               BIGSERIAL PRIMARY KEY,
  user_phone       TEXT NOT NULL,
  plan             JSONB NOT NULL,               -- P1's Plan object verbatim (camelCase: lines, reasonCode, reasonNumbers)
  from_account     TEXT NOT NULL CHECK (from_account IN ('checking','savings','card','car_loan','ira')),
  to_account       TEXT NOT NULL CHECK (to_account IN ('checking','savings','card','car_loan','ira')),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),   -- dollars from P1 * 100, rounded
  action_text      TEXT NOT NULL,                -- "Move $143 from Savings to Checking" (ProposalSummary.actionText)
  source_event_id  TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','declined','expired','completed')),
  channel          TEXT CHECK (channel IN ('text','voice')),     -- where accept/decline came from
  created_sim_at   TIMESTAMPTZ NOT NULL,         -- now()
  expires_at       TIMESTAMPTZ NOT NULL,         -- created_sim_at + 2 hours
  decided_sim_at   TIMESTAMPTZ,
  completed_sim_at TIMESTAMPTZ,
  completed_txn_id TEXT                          -- Nessie/ledger transfer id P1's watcher matched
);
-- At most one pending proposal per user.
CREATE UNIQUE INDEX IF NOT EXISTS proposals_one_pending ON proposals (user_phone) WHERE status = 'pending';

-- Call requests: P2 writes, P4 polls and places the call.
CREATE TABLE IF NOT EXISTS call_requests (
  id              BIGSERIAL PRIMARY KEY,
  user_phone      TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('emergency','monthly_recap')),
  proposal_id     BIGINT REFERENCES proposals(id),
  shortfall       JSONB,                         -- {amount_cents, date, account} from P1's Shortfall (toCallShortfall)
  script_hint     TEXT,                          -- short opener for the voice agent
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','calling','answered','no_answer','busy','failed','cancelled')),
  created_sim_at  TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS call_requests_one_open ON call_requests (user_phone, type)
  WHERE status IN ('pending','calling');

-- Memory (shared by text and voice) --------------------------------------------------------

-- Every message in either direction, any channel. Used for context and "what did we decide?".
CREATE TABLE IF NOT EXISTS memory_messages (
  id              BIGSERIAL PRIMARY KEY,
  user_phone      TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('text','voice')),
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  speaker         TEXT NOT NULL,                 -- 'user' or a cast id
  text            TEXT NOT NULL,
  outbox_id       BIGINT,
  inbound_id      BIGINT,
  call_id         BIGINT,
  created_sim_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_messages_user_idx ON memory_messages (user_phone, created_sim_at DESC);

-- Durable things we learned: goals, preferences ("don't text before 9").
CREATE TABLE IF NOT EXISTS memory_facts (
  id              BIGSERIAL PRIMARY KEY,
  user_phone      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('goal','preference','note')),
  key             TEXT NOT NULL,                 -- e.g. 'goal:vacation', 'pref:quiet_start'
  value           JSONB NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('text','voice','seed')),
  created_sim_at  TIMESTAMPTZ NOT NULL,
  updated_sim_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (user_phone, key)
);

-- Calls: P4's post-call webhook writes summary + decisions.
CREATE TABLE IF NOT EXISTS calls (
  id              BIGSERIAL PRIMARY KEY,
  user_phone      TEXT NOT NULL,
  provider_call_id TEXT UNIQUE,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  call_request_id BIGINT REFERENCES call_requests(id),
  summary         TEXT,
  decisions       JSONB NOT NULL DEFAULT '[]',   -- [{proposal_id, decision: accepted|declined}]
  started_sim_at  TIMESTAMPTZ,
  ended_sim_at    TIMESTAMPTZ,
  duration_ms     INTEGER
);

-- Follow-ups and reminders, fired on now().
CREATE TABLE IF NOT EXISTS follow_ups (
  id              BIGSERIAL PRIMARY KEY,
  user_phone      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('proposal_reminder','escalation_check','goal_checkin','digest')),
  proposal_id     BIGINT REFERENCES proposals(id),
  due_at          TIMESTAMPTZ NOT NULL,          -- simulated time
  payload         JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  created_sim_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS follow_ups_due_idx ON follow_ups (status, due_at);

-- Events P2 has already reacted to (never react to the same event id twice).
CREATE TABLE IF NOT EXISTS agent_event_reactions (
  event_id        TEXT PRIMARY KEY,              -- P1 FinanceEvent.id
  user_phone      TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('reacted','digested','skipped')),
  reacted_sim_at  TIMESTAMPTZ NOT NULL
);

-- Small key/value state for the agents service, e.g. the last finance event id it has read ('events_cursor').
CREATE TABLE IF NOT EXISTS agent_state (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The event itself, so the evening digest can describe what was held back.
ALTER TABLE agent_event_reactions ADD COLUMN IF NOT EXISTS event JSONB;
