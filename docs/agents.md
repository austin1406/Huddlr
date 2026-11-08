# Agents (P2) runbook

The cast (Checking, Savings, Card, Car Loan, IRA, Coach), the moderator, the number checker, proposals, memory,
follow-ups, and escalation. Code in `agents/`, shapes in `contracts/src/agents.ts`, tables in `contracts/p2_agents.sql`.

**The rule everything is built around:** every number a character says comes from P1's finance engine. Gemini only
phrases it, and a code checker rejects any number that isn't in that character's facts. The agents never move money.

## How it fits

```
P1 /events ──► agents (poll every 5 s) ──► moderator ──► characters in parallel ──► number checker ──► outbox ──► P3 sends
                                                    └─► Coach: P1 get_plan ──► proposal ──► "Bottom line: … in your bank app."
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

## Photos and "can I afford it?"

- A photo with no text: the image is fetched from P3 (`GET /photon/attachments/:id`, shared secret), Gemini reads only
  the item and price (JSON), and Checking answers with P1's `can_i_afford` verdict. An unsure reading asks
  "Is that $X for the item?" first; a missing price asks the user to text it.
- "Can I afford a $40 dinner?" by text also goes straight to `can_i_afford`, so the answer is computed, not generated.
- Locally: `curl -XPOST localhost:5055/agents/dev/photo -d '{"path":"test/fixtures/price-tag.png"}'`.

## Priorities and the account summary

- "Prioritize my IRA over savings", "pay off the card first", "card first, then savings", "savings can wait",
  "don't touch my savings", "reset my priorities": saved as `pref:priorities` in memory_facts and confirmed by the
  Coach. Every plan's one move then goes to the user's top-ranked part first (a shortfall is always covered first). A
  plan already waiting is re-pointed ("I've updated the plan: Move … in your bank app.").
- Priorities are sent to P1's `get_plan` as an optional `priorities: { first, last }`. The planner ignores it until it
  supports it; until then priorities change which part is the move, not the amounts.
- "Give me a summary of my account" / "where do I stand": every account in one Coach message, built in code, plus
  priorities and any move still to do.

## How a multi-character reply reads

1. The Coach answers the question first (reply to the user's text) and says who's speaking: "Good question. Card and
   Checking weigh in, then my plan."
2. Each account explains, in turn, one number and what it means for the user ("that costs you $48.00 a month in
   interest"). Never "put it in me": code rejects that, nervous wording ("worried", "be careful") and slang, then
   retries once before the pre-written line.
3. A later account can answer an earlier one by name ("Adding to Card: …"); it's threaded under that message in
   iMessage via `outbox.reply_to_outbox`.
4. The Coach closes with "Bottom line:", the one move ("Move $457.00 from Checking to Card in your bank app."), and the rest for later. It never asks for a YES: the Coach can't move money.

A phone's first text ever gets the Coach's welcome first ("Meet your money: 🏦 Checking, 🐷 Savings, …"), built from
`contracts/cast.json`, once per phone (again after a reset).

## Talking to one character, and celebrations

- **@-mentions:** a text that starts with `@savings`, `@card`, `@car`, `@ira`, `@checking` or `@coach` (also `@piggy`,
  `@credit`, `@retirement`, `@bank`) is answered by that character only, whatever the topic. A bare `@savings` is a
  check-in ("how am I doing with you?"). Only a leading `@` counts, so an email address never reroutes a text.
- **Celebrations:** when P1 reports a transfer (`user_transfer_seen`) into Savings or the IRA, or a payment to the Card
  or Car Loan, that character cheers with the new number ("Nice, $200.00 just landed in savings. You now have enough saved to cover about 2 weeks of must-pay bills…" (was "0.45 months of
  essentials saved now."). Money into Checking is cheered only when it closed a shortfall the crew reacted to in the
  last 7 days ("…the gap is closed. Crisis averted"). Pre-written text built from P1's numbers, so no Gemini call and
  always grounded. Respects quiet hours and the daily cap; held cheers show up in the evening recap.
- Try it on the VM (finance's engine mode): `cd finance && npm run post-transfer -- checking savings 200`. The cheer
  arrives within ~5 s. Locally, `agents/test/celebrate.test.ts` covers every case.

## "I got a $600 bonus, what should I do?"

A text with one dollar amount and a windfall word (bonus, refund, tax return, gift, inheritance, commission, ...) or
"what should I do with" gets the whole crew, not one answer: P1 plans for that amount, the account the plan favors
argues with one rival, and the Coach closes with the bottom line and the move to make in the bank app. It's a reply, so the daily cap and quiet hours
don't apply, and there's a reminder later but never a call. A new plan replaces any plan still waiting, so the move always
approves what the latest message asked. `@savings I got a bonus…` still gets one voice.
The bonus is already in Checking, so a Checking line in P1's plan means "keep this much there" (when short before
payday), never a transfer into Checking; the move takes the rest out of Checking ("Move $457.00 from Checking to Card").
Follow-ups ("why…", "what about the 600?") go to the Coach with the last few texts and the waiting plan, under the
same bottom-line and "who is right" rules as a debate; asking about the same bonus again explains the plan instead of
starting a new one. Replay the phone conversation with real Gemini: `npx tsx scripts/try-windfall.ts`.

## Rules that are tested

- 0 ungrounded numbers: Gate 1 (30 runs) runs in CI with a test model that invents a number in every other reply.
- At most 3 speakers per event, Coach last. Quiet hours 22:00–08:00 and a cap of 6 proactive messages a day
  (`demo_mode` lifts both). Emergencies ignore both.
- The Coach never asks for a YES: it says "Bottom line: … in your bank app." and the plan is checked off when P1's
  watcher sees the transfer (reminder at 60 min; for a shortfall, a call at 90 min if the money hasn't moved). A YES
  text still records agreement (and stops reminders); NO dismisses the plan. Anything else ("maybe", "ok wait", a
  question) is answered like any text; it never approves (0 of 20 in Gate 2) and never gets a "reply YES" nudge.
- One open plan per user; it expires after 2 simulated hours.
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
- Photos work end to end on P2's side; they need P3's `GET /photon/attachments/:id` (shared secret, returns the image
  bytes) to fetch the image. Until then a photo gets "text me the price" instead of silence.
- Still open: prompt polish after real-phone feedback.

## Safety text for Devpost

> **The AI can talk, but it can't move your money.** Huddlr's characters can only *suggest* a move. The Coach ends
> with one plain action ("Move $150.00 from Checking to IRA in your bank app"), and you make it yourself in your own
> bank. Nothing is ever moved for you, and no reply you send can move money either.
>
> **Every number comes from code.** A plain-code finance engine computes balances, forecasts, and plans. The language
> model only phrases them, and a number checker rejects any figure that isn't in the facts it was given, falling back
> to a pre-written message. We tested this with a model that deliberately invents numbers: 0 invented numbers were sent.
>
> **Quiet by default.** At most 3 characters speak per event, there are quiet hours and a daily message cap, and
> everything else waits for one evening recap. Only a real emergency (a shortfall within 48 hours) breaks through,
> and it ends in a phone call only if the money still hasn't moved.
>
> **Never asks for secrets.** The agents never ask for passwords, one-time codes, or account numbers.
>
> **Demo conveniences, disclosed.** The voice line's caller allowlist is a demo convenience, not security (caller ID can
> be faked); the real protection is that nothing can move money. All customer data is synthetic, and the IRA, card APR
> and limit, and fast-forwarded time are simulated.
