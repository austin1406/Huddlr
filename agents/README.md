# agents/

The cast: moderator, six characters, number checker, proposals, memory.

Owner: Sreyas Chakka (@sreyas-chakka), P2

- Moderator: at most 3 speakers, quiet hours, daily cap, evening digest
- Debates: positions and the Coach's plan generated in parallel; budget of about 5 seconds to the first message and 15 to the plan
- Number checker: every number must come from the facts, otherwise retry once (if time allows) or use a template
- `ProposalService`: the single code path for accept, decline, expire, and mark completed. Text, voice, and the finance watcher all call it.
- Memory shared across text and voice
- Writes outbox rows only; never talks to Photon directly

## Run it

```bash
cd agents && npm install
npm test                       # typecheck + all tests (no key needed)
npm run harness -- --fake      # full reaction with a fake model that invents "$63" so you see the checker catch it
npm run harness                # same with real Gemini (GEMINI_API_KEY in ../.env)
npm run harness -- --event forecast_problem --fixture shortfall --runs 10
```

- `src/checker.ts`: number checker. Each character is checked against its own slice of the facts (plus the plan for the Coach).
- `src/character.ts`: prompt, Gemini call, retry once if time allows, grounded template fallback.
- `src/moderator.ts`: who speaks (max 3, Coach last on plan events), quiet hours, daily cap, digest, emergencies bypass both.
- `src/harness.ts`: Gate 0 harness. Exit code 1 if any ungrounded number would be sent.

## Proposal service (for P1 and P4)

Served on port 5000 (`AGENTS_PORT`); Caddy routes `/agents/*` here. Every call except health sends `x-huddlr-secret: $HUDDLR_SECRET`.
Ids are numbers; P1's finance wrapper converts its string ids with `Number(id)`. Responses are `ProposalResult` (`contracts/src/agents.ts`).

| Call | Body | Notes |
|---|---|---|
| `GET /agents/health` | | no secret needed |
| `GET /agents/proposals/pending?userPhone=+1...` | | defaults to `DEMO_USER_PHONE`; returns `{ proposal: ProposalSummary \| null }` |
| `POST /agents/proposals` | `{ plan, from, to, amount, actionText, sourceEventId? }` | dollars in; replaces any older pending plan |
| `POST /agents/proposals/:id/accept` | `{ via: "text" \| "voice" }` | 200 ok; 409 `already_accepted` / `expired` / `not_pending`; 404 `not_found` |
| `POST /agents/proposals/:id/decline` | `{ via }` | |
| `POST /agents/proposals/:id/expire` | | |
| `POST /agents/proposals/:id/complete` | `{ txnId }` | P1's watcher. Works from accepted or pending (user moved money without texting YES) |
| `POST /agents/reset` | | reset-agents: clears P2's tables |

Rules (all on simulated time from `sim_state`): plans expire 2 hours after creation; one pending plan per user; a second YES
changes nothing and sends nothing; a late YES gets "that plan expired"; an unclear reply ("maybe?", "yes but $50") is never a yes.

Start it: `DATABASE_URL=... npm start`. It creates its tables, serves the API, and polls `inbound_messages` every second.

## Events, debates, memory (H5-9)

`npm start` also polls P1's `/events` every 5 s (`AGENTS_EVENTS_POLL_MS`) from `FINANCE_URL` (default `http://localhost:4000`).

- `src/debate.ts`: each new event is claimed once (`agent_event_reactions`), the moderator decides, account characters and
  the Coach run in parallel, each account message is queued as soon as it is ready, and the Coach goes last. On a shortfall
  or a paycheck surplus the Coach calls P1's `get_plan`, a proposal is created from the first plan line
  ("Move $143.00 from Savings to Checking"), and the Coach asks for a YES to exactly that. Held-back events go into one
  evening digest at 7 pm (simulated, local).
- `src/chat.ts` + `src/memory.ts`: texts that aren't proposal answers. Goals ("saving $2,000 for a car by May") and
  preferences ("don't text me after 9pm") go to `memory_facts` and get a short ack; questions get one grounded answer
  from the right character.
- `test/debate.test.ts` runs against P1's real finance stub app in-process, so a contract mismatch fails CI.

## Try it on your laptop (no database needed)

```bash
cd finance && FINANCE_SCENARIO=shortfall npm start          # P1's stub on :4000
cd agents && npm run local                                  # agents on :5055 (macOS AirPlay owns 5000), Postgres in agents/.data
curl -XPOST localhost:5055/agents/dev/demo -d '{"on":true}'   # bypass quiet hours
curl -XPOST localhost:4000/admin/events -H "x-huddlr-secret: $HUDDLR_SECRET" -H 'content-type: application/json' \
  -d '{"id":"evt_forecast_problem_1","type":"forecast_problem","occurredAt":"2026-12-02T15:00:00.000Z","severity":"high","accountId":"checking","data":{}}'
curl localhost:5055/agents/dev/chat                          # the conversation as the phone would show it
curl -XPOST localhost:5055/agents/dev/jump -d '{"hours":1.5}' # fast-forward: reminder, then escalation
curl -XPOST localhost:5055/agents/dev/text -d '{"text":"yes"}'
```

On the first start (or after `/agents/reset`) the agents skip the existing event backlog and react only to new events.

## Follow-ups and escalation (H14, H17)

- Every proposal gets a reminder after 60 simulated minutes if still unanswered.
- An emergency (shortfall within 48 h) also gets an escalation check at 90 minutes: if the plan is still unanswered and
  the shortfall is still in the facts, a `call_requests` row (type `emergency`, shortfall in cents, a one-line
  `script_hint`) is written for P4's voice agent, plus a priority-2 text saying a call is coming.
- A YES, NO, or completed transfer cancels any call request that P4 hasn't started (`status = 'cancelled'`).
- When P1's watcher calls `/complete`, the Coach confirms once: "Saw it: you moved $143.00 from Savings to Checking."

## Deploy (on the VM)

`/opt/huddlr/agents/deploy/deploy.sh` — pulls main, installs, (re)starts `agents` under pm2, checks `/agents/health`.
Needs `DATABASE_URL`, `HUDDLR_SECRET`, `DEMO_USER_PHONE`, `GEMINI_API_KEY` in `/opt/huddlr/.env`.

## Gate 1 and reset

```bash
npm run gate1                          # 30 scripted runs + quiet hours, cap, emergency, duplicates, 2-day clock test, reset, transfer ack (fake model, no quota)
npm run gate1 -- --real --runs 6       # same with real Gemini, paced for the free tier
npm run reset                          # reset-agents against the running service (AGENTS_URL, else PUBLIC_BASE_URL)
```

`npm test` (and CI) runs Gate 1 with the fake model, which invents a number in every other reply, so a grounding regression fails the build.
Last real run: 20 messages, 0 ungrounded numbers, median 557 ms to the first message.
