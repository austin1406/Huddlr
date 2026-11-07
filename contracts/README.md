# contracts/

Shared schemas, fixtures, and helpers. This is the one folder everyone reads. **Changes are additive-only** (add fields, never rename or delete) and are announced in chat.

## To write in hour 1

**P1 owns**
- Facts snapshot schema and a fixture (balances, bills, forecast, indicators, pending proposals, events, shortfall)
- Event types and the events table (with a duplicate-protection ID)
- Tool API: `get_snapshot`, `can_i_afford(amount)`, `what_if(scenario)`, `get_plan(amount)`, `get_pending_proposal`, `accept_proposal(id)`
- Plan shape (destination, amount, reason code, reason numbers) and scenario types (`purchase_now`, `lose_income`, `one_time_expense`, `new_recurring`)
- `persona.json`: the demo customer
- `sim_state` table and the shared `now()` helper

**P2 owns**
- Outbox row (with optional `attachment: indicator_card` and `reply_to`) and inbound message schemas
- `ProposalService` interface: get pending, accept, decline, expire, mark completed
- `call_requests` schema with `type`: `emergency` or `monthly_recap`
- Memory tables: messages, facts, calls, follow_ups

## The clock rule

One database row, `sim_state {offset_seconds, demo_mode}`, and one shared `now()` = real time + offset.

- **Uses `now()`:** bills, paychecks, forecast, proposal expiry, quiet hours, daily cap, follow-ups, escalation cutoff, transaction dates.
- **Uses the real clock:** typing gaps, retries, timeouts, polling, latency metrics.
- `demo_mode` bypasses quiet hours, relaxes the daily cap, and shortens typing gaps. Emergencies are unaffected.
- The demo controller always lands on daytime simulated times.
- New transactions are detected by ID, never by date.
