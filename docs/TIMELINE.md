# Huddlr timeline

Four people, about 24 hours. **Hackathon start time (H0): ____ . Submission deadline: ____ .** Write the real clock times next to each gate once you know them.

| Role | Person | Folders |
|---|---|---|
| P1 Finance engine | Austin (@austin1406) | `finance/`, `contracts/` (finance part) |
| P2 Agents | Sreyas (@sreyas-chakka) | `agents/`, `contracts/` (message part) |
| P3 Photon text, dashboard, demo controller | Shreya (@shreyaBalaji1) | `photon/`, `dashboard/` |
| P4 Voice, seed script, video, Devpost | Rishi (@rishivallabhaneni) | `voice/`, `scripts/seed/` |

## Shared rules

- **Gates:** Gate 0 at H3, dry run at H6, Gate 1 at H10, Gate 2 at H19, feature freeze at H20.
- **Merge points:** H3, H5, H8, H10, H15, H17, H19. Follow `GIT_WORKFLOW.md`: your own folder, short-lived branches, no force-push, nothing to `main` directly.
- **Sleep:** P1+P2 H11-14, P3+P4 H14-17. Standing 5-minute syncs at H3, H6, H10, H14, H17, H19, H20.
- **Stuck for 30 minutes means ask a mentor or the booth.**
- **Cut order if behind:** multi-voice, then photos, then emergency outbound call (keep inbound), then optimizer polish, then dashboard, then voice entirely. Never cut: forecast, indicators, number checker, safety rules, backup video.
- **Clock rule:** one `sim_state` row (`offset_seconds`, `demo_mode`) and one shared `now()` (real time plus offset). Calendar logic uses it: bills, paychecks, forecast, proposal expiry, quiet hours, daily cap, follow-ups, escalation cutoff, transaction dates. Delivery mechanics use the real clock: typing gaps, retries, timeouts, polling, latency. `demo_mode` bypasses quiet hours, relaxes the cap, and shortens typing gaps; emergencies are unaffected. New items are detected by ID, never by date.
- **Ownership:** P2 owns proposals (P1 and P4 call P2's service). P3 owns the fixed domain. P1 owns the clock and CLI scripts.

---

# P1: Austin, Finance engine

**H0-1: Contracts**
- [ ] Clone outside OneDrive, git identity, test branch, `.env`
- [ ] Facts schema: balances, bills, forecast, indicators, pending proposals, events, shortfall
- [ ] Event types and events table with duplicate protection
- [ ] Tool API: `get_snapshot`, `can_i_afford`, `what_if`, `get_plan`, `get_pending_proposal`, `accept_proposal`
- [ ] Plan shape and scenario types (`purchase_now`, `lose_income`, `one_time_expense`, `new_recurring`)
- [ ] `persona.json`: balances, bills, paycheck, daily spend, card APR and limit, car loan, simulated IRA, match, goals
- [ ] Thresholds: big purchase, cushion, indicator cutoffs
- [ ] `sim_state` table and `now()` helper. The engine takes `asOf` from `now()`.
- [ ] Fixtures. Review P2's contracts. Merge.

**H1-2: Nessie spike**
- [ ] Base URL, endpoints, write and read back, do balances update, does it accept custom transaction dates?
- [ ] If balances or dates don't work, plan an own-ledger mirror. Save `docs/nessie.md`.

**H2-3: Skeleton and stub. Gate 0**
- [ ] Project and tests, data source interface (persona now, Nessie later)
- [ ] Stub server on P3's fixed domain returning fixtures at the final URLs. Post the URL. Merge.

**H3-4: Forecast and `can_i_afford`**
- [ ] Day-by-day walk, lowest balance, first negative day, safe-to-spend, 3 hand-checked tests
- [ ] Swap the real forecast into the stub. **Facts v0 live at H4.**

**H4-5: Five indicators**
- [ ] Thresholds in one config, hand-check tests, facts v0.5. Merge.

**H5-6: Plan v0**
- [ ] `get_plan`: shortfall plus cushion, then highest-APR debt, then emergency fund to one month, each with a reason. Tests.

**H6-7: Dry run and Nessie source**
- [ ] 20-minute dry run with P2. Build `NessieSource`. Check P4's seed (if late, seed minimally).

**H7-8: Sync, golden test, CLI scripts**
- [ ] Poll every 30-60 seconds, **detect new items by ID, not date**
- [ ] Golden test: Nessie-derived facts match persona-derived facts
- [ ] **Commit scripts:** `post-purchase`, `post-transfer`, `post-paycheck`, `post-bill`, `jump-days N`, `reset`. Merge at H8.

**H8-9: Event detector**
- [ ] `big_purchase`, `paycheck_landed`, `bill_due_soon`, `forecast_problem`, tested with the scripts

**H9-10: Watcher, tool wrappers, Gate 1**
- [ ] `get_pending_proposal` and `accept_proposal` call P2's proposal endpoints (they never write the table)
- [ ] Watcher matches the transfer and calls P2's `markCompleted`
- [ ] Gate 1, including the clock test (jump 2 days). **Freeze the API shape.** Merge.

**H10-11: Wrap-up**
- [ ] Fix bugs, write `docs/finance.md`, handoff note, issues labeled `finance`. **Sleep H11-14.**

**H14-15:** [ ] What-if: `lose_income`, `one_time_expense`, `new_recurring`. Merge.
**H15-16:** [ ] Optimizer v1: shortfall, match, high-interest debt, emergency fund (1 then 3 months), goals, split the rest. Keep a switch back to v0.
**H16-17:** [ ] Shortfall flag in the facts (within 48 hours, amount, date, account). Merge.
**H17-18:** [ ] Hand-check the forecast on 3 simulated dates.
**H18-19:** [ ] Test the emergency path with P2 and P4. Record metrics. **Gate 2.**
**H19-20:** [ ] Bugfixes only. **H20 freeze.**
**H20-21:** [ ] Check P3's fast-forward and reset give correct facts.
**H21-22:** [ ] Failure drill: flip to the persona source if Nessie goes down.
**H22-23:** [ ] Metrics section for Devpost. Submit 1-2 hours early.
**H23-24:** [ ] Buffer.

---

# P2: Sreyas, Agents

**H0-1: Contracts**
- [ ] Clone, identity, test branch, `.env`
- [ ] Schemas: outbox (with `attachment: indicator_card` and `reply_to`), inbound, proposal, `call_requests` (with `type`: `emergency` or `monthly_recap`), memory tables
- [ ] Publish the `ProposalService` interface: get pending, accept, decline, expire, mark completed
- [ ] The cast (6 characters), safety rules, quiet-hours config in simulated time
- [ ] **Decide the character model (a fast one) and get its key.** Review P1's contracts. Merge.

**H1-2:** [ ] Run Card against the fixture. Prototype the number checker (formats allowed) and prove it catches an invented number.
**H2-3: Gate 0:** [ ] Local harness. A character reply with 0 ungrounded numbers.
**H3-4:** [ ] Moderator v0: relevance, at most 3 speakers, quiet hours, daily cap, digest, using `now()` and `demo_mode`. 5 tests.
**H4-5:** [ ] Six characters on facts v0, each tested on 3 situations through the checker. Merge.

**H5-6: Parallel debate**
- [ ] Generate the round-1 positions and the Coach's plan (from `get_plan`) in parallel, and send each message as it's ready
- [ ] Run round 2 only if time remains. Retry the checker only if time remains, otherwise use the template.
- [ ] Targets: first message under 5 seconds, plan under 15. Write outbox rows only.

**H6-7:** [ ] Dry run with P3. Create the proposals table (`p2_` migration) and tell P1. Reply classifier (clear yes, no, otherwise unclear means not approved).

**H7-8: Proposal service**
- [ ] Implement accept, decline, expire, mark completed with a 2-hour expiry on `now()`. **Expose endpoints by H8.** Text and voice use the same code. Merge.

**H8-9:** [ ] Consume events, send 1-3 reactions or the digest, never react to the same event ID twice. Memory: save messages, goals, preferences.

**H9-10: Gate 1**
- [ ] Acknowledge when P1 marks a transfer completed. 30 scripted runs with 0 ungrounded numbers. Quiet rules and cap hold. `reset-agents` script. Clock test. Merge.

**H10-11:** [ ] Fix bugs, `docs/agents.md`, freeze formats, handoff. **Sleep H11-14.**
**H14-15:** [ ] Follow-ups and reminders on `now()`.
**H15-16:** [ ] Edge cases: duplicate YES, expired plan reply, goals into memory. Force a checker failure to test the template. Load the last call summary so "what did we decide?" works by text.
**H16-17:** [ ] Photos, the first thing to cut: Gemini reads item and price, confirm uncertain readings, `can_i_afford`. Merge.
**H17-18:** [ ] Escalation: P1's shortfall flag, send the warning, no reply by your cutoff (simulated time) writes a `call_requests` row. Insert a manual test row for P4. Optional: write a `monthly_recap` row.
**H18-19: Gate 2:** [ ] Metrics over 50 simulated chats, including time-to-first-message and time-to-plan. Run the restraint metrics with `demo_mode` off.
**H19-20:** [ ] Bugfixes only. **H20 freeze.**
**H20-21:** [ ] Rehearse and check the reset script.
**H21-22:** [ ] Failure drill: model down or slow, template fallback.
**H22-23:** [ ] Devpost track mapping and safety text (say the caller allowlist is a demo convenience, not security). Submit early.
**H23-24:** [ ] Buffer.

---

# P3: Shreya, Photon text, dashboard, demo controller

**H0-1: Setup**
- [ ] Clone, identity, test branch, `.env`
- [ ] **Fixed domain and HTTPS on the Vultr VM first** (DNS takes time). No ngrok except 20-minute local debugging. Give the URL to P1, P2, P4.
- [ ] CI green. Photon project with iMessage. Review contracts, merge.

**H1-2:** [ ] Assign your own phone a seat, text the line, receive it as an inbound row, reply.
**H2-3: Gate 0:** [ ] Send and receive an image, test typing and threaded replies, confirm the agent can only message after the user texts first. `docs/photon.md`.
**H3-4:** [ ] Webhook with signature check and duplicate protection. Save text and attachment IDs.
**H4-5:** [ ] Outbox sender: one at a time, 1-3 second gaps (real clock, shorter in `demo_mode`), typing if supported, 3 retries, idempotent. Merge.
**H5-6:** [ ] Format "emoji Name: text", `reply_to` if supported. Send a P2 row to your phone.
**H6-7:** [ ] Dry run. Indicator card renderer (5 gauges as a PNG) for `attachment: indicator_card`.
**H7-8:** [ ] Store inbound images and expose the path to P2. Merge.
**H8-9:** [ ] Seat tool (assign, list, 25 limit). Hold proactive messages until the user has texted. **Test with a fresh phone never used in development.**
**H9-10: Gate 1:** [ ] Real-phone run, 60-second fallback clip, dashboard skeleton on `/facts`. Merge.
**H10-12:** [ ] Dashboard: 5 gauges, 45-day forecast chart with the lowest point and first negative day, refreshing every 2-3 seconds.
**H12-13:** [ ] Chat mirror, event log, proposal status.
**H13-14:** [ ] Screen-share polish, runbook (restart sender, check seats, common errors), handoff note. Merge. **Sleep H14-17.**

**H17-18: Controller, part 1**
- [ ] Wrap P1's scripts: post purchase, paycheck, bill, user's transfer. Transactions dated by `now()`.

**H18-19: Controller, part 2. Gate 2**
- [ ] Fast-forward uses `jump-days` and **lands on daytime**. Toggle `demo_mode`. `reset-all` calls each service's reset, under 30 seconds. Merge.

**H19-20:** [ ] Demo-day checklist (seats, charged phones, hotspot, mirroring, speaker). Repeat the fresh-phone test. **H20 freeze.**
**H20-21:** [ ] Run the controller in rehearsal and time each step.
**H21-22:** [ ] Failure drill: dead webhook and stuck sender recovery.
**H22-23:** [ ] Architecture diagram and screenshots. Submit early.
**H23-24:** [ ] Buffer.

---

# P4: Rishi, Voice, seed script, video, Devpost

**H0-1: Setup**
- [ ] Clone, identity, test branch, `.env`
- [ ] Accounts and keys: ElevenLabs, Gemini (share with P2), Nessie (share with P1). **Decide the voice agent's model.**
- [ ] Organizer questions: does the two-track cap include sponsor and MLH prizes, dedicated lines, outbound calls and SMS number, seats beyond 25? Save to `docs/organizers.md`.
- [ ] **Start the SMS number purchase now.** Get P3's fixed domain URL for every webhook and tool URL. Review contracts, merge.

**H1-2:** [ ] Add the SMS number and default SIP voice profile. Create an ElevenLabs agent, import the number following Photon's cookbook exactly (TLS).
**H2-3: Gate 0:** [ ] Inbound test call with audio both ways, outbound credentials and test call. `docs/voice.md`. If no number, voice is cut and you start the video and Devpost early.
**H3-4:** [ ] Seed script part 1: read `persona.json`, create customer and accounts, safe to re-run, with a reset mode.
**H4-5:** [ ] Part 2: 60 days of purchases across 10-15 merchants, biweekly paychecks, bills, P2P transfers. Verify, tell P1. Merge.
**H5-6:** [ ] Voice agent prompt (short answers, only tool results, never asks for sensitive information, offers a text follow-up). Wire the 5 tools to **P1's stub URLs** on the fixed domain with a shared secret. Test "what's my balance?"
**H6-7:** [ ] Small `/voice` service passing recent events, pending proposals, and goals at call start.
**H7-8:** [ ] Post-call webhook saves summary and decisions to `calls` and writes a recap row to the outbox. Merge.
**H8-9:** [ ] Check numbers heard match `/facts`. "Can I afford $40 dinner tonight?" uses `can_i_afford`.
**H9-10:** [ ] 3 test calls with latency noted. Merge.
**H10-11:** [ ] Inbound polish: caller allowlist (a demo convenience, not security, since caller ID can be faked). A voice yes only calls accept when it's clearly yes.
**H11-12:** [ ] **Named characters:** "put me through to Savings" or "what does Card think?" switches persona with the same tools and numbers. 3 end-to-end calls, measure recap delay.
**H12-14:** [ ] Test whether ElevenLabs can switch voices mid-call. If not, one voice that announces who's speaking. Failed or unanswered calls send a text fallback. Median latency over 5 calls. Runbook (test call, rotate outbound password, SIP 403 and 407, allowed countries). Merge, handoff note. **Sleep H14-17.**

**H17-18:** [ ] Emergency call part 1: poll `call_requests` (type `emergency`), place the call with shortfall details, test with a manual row.

**H18-19: Gate 2**
- [ ] Part 2: explain the shortfall, ask "will you move $X today?", a clear yes goes through `accept_proposal`. Unanswered, busy, or failed sends a text. Test with P2's escalation and P1's flag. Only call opted-in numbers.
- [ ] Stretch, only if that works: `monthly_recap` type with a short script.

**H19-20:** [ ] Re-verify demo numbers and the emergency-only quiet-hours exception. **H20 freeze.**
**H20-21:** [ ] Rehearse the call section. Decide the judge phone versus a teammate's phone on speaker. **Recap test with a fresh phone.**
**H21-22:** [ ] Failure drill (call fails, show the text fallback). Record the 2-minute backup video.
**H22-23:** [ ] Devpost: description, per-track sections, simulated data disclosed, README, repo public, no secrets in history, opt into MLH categories. **Submit 1-2 hours early** and tag `submission`.
**H23-24:** [ ] Buffer. Draft the DEV post.

---

# Hand-off map

| When | From | To | What |
|---|---|---|---|
| H0-1 | P1 | all | `sim_state`, `now()`, contracts |
| H0-1 | P2 | P1 | `ProposalService` interface |
| H0-1 | P3 | P1, P2, P4 | Fixed domain URL |
| H3 | P1 | P2, P3, P4 | Stub server URLs |
| H4-5 | P1 | P2, P4 | Facts v0, then v0.5 |
| H5 | P3 | P2, P4 | Outbox sender |
| H5 | P4 | P1 | Seeded Nessie data |
| H5-6 | P1 | P2 | `get_plan` v0 |
| H8 | P1 | P2, P3 | CLI scripts |
| H8 | P2 | P1, P4 | Proposal endpoints |
| H9-10 | P1 | P3, P4 | API frozen |
| H16-17 | P1 | P2, P4 | Shortfall flag |
| H17-18 | P2 | P4 | `call_requests` rows |
| H18-19 | P3 | all | Demo controller |
