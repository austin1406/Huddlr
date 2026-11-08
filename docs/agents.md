# Agents (P2) runbook

The cast (Checking, Savings, Card, Car Loan, IRA, Coach), the moderator, the number checker, proposals, memory,
follow-ups, and escalation. Code in `agents/`, shapes in `contracts/src/agents.ts`, tables in `contracts/p2_agents.sql`.

**The rule everything is built around:** every number a character says comes from P1's finance engine. Gemini only
phrases it, and a code checker rejects any number that isn't in that character's facts. The agents never move money.

## How it fits

```
P1 /events ──► agents (poll every 5 s) ──► moderator ──► characters in parallel ──► number checker ──► outbox ──► P3 sends
                                                    └─► Coach: P1 get_plan ──► proposal ──► "Reply YES to: …"
P3 inbound_messages ──► agents (poll every 1 s) ──► YES/NO ──► ProposalService ◄── P1 accept_proposal (voice) / watcher /complete
follow_ups (sim clock) ──► reminder at 60 min ──► escalation at 90 min ──► call_requests ──► P4 calls
```

- Port **5000** on the VM; Caddy routes `/agents/*` there. Every call except `/agents/health` needs `x-huddlr-secret`.
- Calendar logic (quiet hours, cap, digest, expiry, follow-ups) runs on simulated time from `sim_state`. Polling and timeouts use the real clock.

## Deploy, check, reset

```bash
# on the VM
cd /opt/huddlr && git pull && ./agents/deploy/deploy.sh      # pm2 process "agents"; creates its own tables
curl -s localhost:5000/agents/health                         # {"ok":true, "gemini":{...}}
pm2 logs agents --lines 50

# from anywhere with the shared .env
cd agents && npm run reset                                   # clears P2's tables (demo start)
npm run gemini-status                                        # is the Gemini key usable right now?
```

`/opt/huddlr/.env` needs `DATABASE_URL`, `HUDDLR_SECRET`, `DEMO_USER_PHONE`, `GEMINI_API_KEY` (and `FINANCE_URL` only if
finance isn't on localhost:4000).

## What normal looks like in the logs

```
[agents] listening on :5000/agents
[agents] event evt_forecast_problem_…: react (emergency) first=702ms plan=2273ms
[agents] text 41: accepted
[agents] text 42: chat -> card
[agents] follow-up 3 (proposal_reminder): reminded
[agents] follow-up 4 (escalation_check): called
```

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `/agents/health` is 502 | process not running | `pm2 restart agents`, then `pm2 logs agents` |
| `/agents/health` is 503 | database down or wrong `DATABASE_URL` | check Postgres on the VM, then restart |
| `[agents] Gemini … limit` in logs | free-tier rate limit | nothing breaks: characters send grounded templates. `npm run gemini-status` says when it resets; swap `GEMINI_API_KEY` for a backup key and restart |
| `402 prepayment credits are depleted` | paid-tier key with $0 credit | use the free-tier key or add credits in AI Studio |
| Characters never react to events | `DEMO_USER_PHONE` empty, or finance unreachable | set it; check `curl localhost:4000/health` |
| Messages queued but never arrive | user hasn't texted the line yet (P3 holds proactive messages), or P3's sender is down | text the line first; check `/photon/health` |
| Reacted to old events after a restart | it shouldn't: on first start and after reset the agents skip the backlog | if it happens, `npm run reset` |
| A YES did nothing | no pending plan (expired after 2 h, or already accepted) | the Coach replies with the reason; check `GET /agents/proposals/pending` |
| A call came after the user said YES | shouldn't happen: any YES/NO/transfer cancels pending `call_requests` | check `call_requests.status`; P4 should only call `pending` rows |

## Rules that are tested

- 0 ungrounded numbers: Gate 1 (30 runs) runs in CI with a test model that invents a number in every other reply.
- At most 3 speakers per event, Coach last. Quiet hours 22:00–08:00 and a cap of 6 proactive messages a day
  (`demo_mode` lifts both). Emergencies ignore both.
- Only a clear YES approves. "maybe", "yes but $50", "ok wait" never do (0 of 20 in Gate 2).
- One pending plan per user; it expires after 2 simulated hours. A second YES does nothing.
- Never react to the same event id twice.

## Metrics

See `docs/metrics-p2-real.md` (real Gemini) and `docs/metrics-p2.md` (test model). Last real run: first message
p50 711 ms / p90 990 ms, plan p50 2.3 s / p90 4.7 s, 0 ungrounded numbers.

## Handoff note (while P2 is asleep)

- Everything is merged to `main` and deployed with `agents/deploy/deploy.sh`. If the agents misbehave during a demo,
  `npm run reset` and `pm2 restart agents` are always safe.
- Gemini runs on a free-tier key. If it's rate-limited, the chat still works with templates; a backup key can be
  dropped into `.env` and `pm2 restart agents --update-env`.
- Formats are frozen: additive changes only (`contracts/src/agents.ts`, `contracts/p2_agents.sql`, `contracts/cast.json`).
- Still open on P2's list: photo reading (first to cut), prompt polish after real-phone feedback.

## Safety text for Devpost

> **The AI can talk, but it can't move your money.** Huddlr's characters can only *propose* a transfer. You approve it
> with a clear YES, and you move the money yourself in your own bank. An unclear reply ("maybe", "yes but only $50")
> is treated as no.
>
> **Every number comes from code.** A plain-code finance engine computes balances, forecasts, and plans. The language
> model only phrases them, and a number checker rejects any figure that isn't in the facts it was given, falling back
> to a pre-written message. We tested this with a model that deliberately invents numbers: 0 invented numbers were sent.
>
> **Quiet by default.** At most 3 characters speak per event, there are quiet hours and a daily message cap, and
> everything else waits for one evening recap. Only a real emergency (a shortfall within 48 hours) breaks through,
> and it ends in a phone call only if you haven't answered.
>
> **Never asks for secrets.** The agents never ask for passwords, one-time codes, or account numbers.
>
> **Demo conveniences, disclosed.** The voice line's caller allowlist is a demo convenience, not security (caller ID can
> be faked); the real protection is that nothing can move money. All customer data is synthetic, and the IRA, card APR
> and limit, and fast-forwarded time are simulated.
