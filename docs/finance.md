# Finance engine (P1): handoff

Owner: Austin Santhakumar (@austin1406). Code: `finance/`. Contracts: `contracts/`. Nessie notes: `docs/nessie.md`.

The finance engine is the only place a number comes from. Characters, the dashboard, the voice agent and the emergency call all ask it. It is plain code with no AI in it. It never moves money; it only reports and advises.

## What it answers

Public base URL: `https://144-202-69-37.sslip.io`. Send `x-huddlr-secret: $HUDDLR_SECRET` on everything except `/health`.

| Call | What you get | Used by |
|---|---|---|
| `GET /health` | `{ok, service, mode, source}`; `sourceError` if Nessie is unreachable | anyone, no secret |
| `GET /facts` | The full snapshot: accounts, bills, paychecks, 45-day forecast, 5 indicators, pending proposal, recent events, shortfall | agents, dashboard, voice |
| `GET /events?after=<id>&limit=50` | New things that happened, oldest first. `after` is an event id | agents (polling) |
| `POST /tools/can_i_afford {amount}` | `yes`, `tight` or `no`, with the lowest balance after and the first negative day | agents, voice |
| `POST /tools/what_if {scenario}` | Before and after for `purchase_now`, `lose_income`, `one_time_expense`, `new_recurring` | agents, voice |
| `POST /tools/get_plan {amount}` | Where a sum of money should go, each line with a reason and its numbers | agents |
| `POST /tools/get_pending_proposal`, `accept_proposal` | Thin wrappers over the agents service, which owns proposals | voice |
| `POST /tools/get_snapshot` | Same as `/facts`, for tool callers | voice |
| `POST /tools/project {amount, unit}` | Every account over a window you choose (days, weeks, months, years, up to 10), with interest and payoffs; `compare: true` adds the Coach-plan path | dashboard (the Huddle's forecast) |

Shapes live in `contracts/src/`. Every response is parsed with those schemas in the tests.

## The ideas that matter

- **One clock.** `now()` is real time plus the `sim_state.offset_seconds` row. Bills, paychecks, the forecast, proposal expiry and quiet hours all use it, so `jump-days` makes time pass. Delivery mechanics (retries, typing gaps, polling) use the real clock.
- **Forecast.** 45 days from today, day 0 included. Each day: paycheck if payday, then bills due, then the average daily spend ($38), then record the end-of-day balance. Safe to spend = the lowest balance before the next payday minus the $100 cushion. `can_i_afford` says `yes` if the lowest balance after the purchase stays at or above the cushion, `tight` if it stays at or above zero, `no` if it goes negative.
- **Shortfall.** The first negative day, how far below zero it gets at its lowest, hours until that first short day ends, and `suggestedTransfer` (the gap plus the cushion). `within48Hours` drives the emergency call.
- **Indicators.** Runway, credit utilization, savings rate, bill reliability, retirement on track. Cutoffs are in `contracts/thresholds.json`, and each indicator carries its raw numbers so characters can quote them.
- **Ledger.** The engine keeps Maya's balances itself. Days that pass are settled the next time anything reads: paychecks land, bills are paid (rent, car loan and the card minimum also reduce those balances), daily spending posts. A bill paid while checking is overdrawn counts as late and resets the on-time streak.
- **Events** are found by source id, never by date: `paycheck_landed`, `big_purchase` (over $75), `bill_due_soon` (3 days), `forecast_problem` (negative within 14 days), `user_transfer_seen`, `p2p_imbalance`. Reading twice never repeats one.
- **Plan optimizer v1** (default). In order: cover a shortfall plus the cushion; capture the unclaimed employer match ($150); pay debt above 8% APR, highest first; emergency fund to 1 month of essentials; goals; emergency fund to 3 months; split the rest between extra retirement and the car loan. Anything unusable is `unallocated`. v0 (simple rules) is one switch away.
- **Projection** (`POST /tools/project`). The 45-day forecast follows checking only. The projection follows all five accounts for a window the user picks, day by day with the forecast's own rules (day 0 included), and adds what a long window needs: monthly interest on the card (24%) and car loan (6.9%), payments that stop when a debt is gone, and optional growth on savings and the IRA (off unless asked, so no return is invented). Returns `start`, `points` (daily up to 120 days, weekly up to about 2 years, every 30 days beyond, last day always included), a `summary` (net worth start to end, lowest checking, first negative day, debt payoff dates, interest paid, emergency fund in months) and plain-language `assumptions`. With `compare: true` it also returns the same window if the Coach's plan were followed: at each month end, checking above one month of bills plus the cushion goes through plan v1. The first 30 days equal the 45-day forecast day for day (tested). Not modeled: raises, inflation, new card spending, loans added by text.
- **Transfer watcher.** When a user transfer is seen, the engine finds the open proposal (pending or accepted) with the same accounts and an amount no larger than the transfer, and tells the agents service to mark it completed. If the agents service is down it retries every 15 seconds.
- **Nessie** is the transaction log, not the source of balances (it cannot hold them). See `docs/nessie.md`. Off by default.

## Running it

```bash
cd finance && npm install && npm run dev        # http://localhost:4000
npm test                                        # typecheck + 69 tests
```

On the VM: `bash finance/deploy/deploy.sh` (pm2 process `finance`). Env (shared `/opt/huddlr/.env`):

| Variable | Meaning |
|---|---|
| `HUDDLR_SECRET` | shared secret; auth is off if empty (local only) |
| `FINANCE_PORT` | default 4000 (Caddy routes `/facts*`, `/tools/*`, `/events*`, `/health` here) |
| `FINANCE_MODE` | `engine` (default) or `stub` (fixtures only) |
| `DATA_SOURCE` | `persona` (default) or `nessie`; needs `NESSIE_API_KEY` |
| `DATABASE_URL` | shared Postgres; the `sim_state` row lives there so the agents service sees the same clock. Without it the clock is a local file |
| `AGENTS_URL` | where proposals are forwarded; default `http://localhost:5000` |
| `PLAN_VERSION` | `v1` (default) or `v0` |
| `FINANCE_DATA_DIR` | ledger and event log; survive restarts. Default `finance/.data` (git-ignored) |

## Demo controls

`/admin/*` is **not** reachable from the internet (Caddy answers 404). The dashboard's demo controller calls it on localhost; from the VM or your laptop use the CLI in `finance/`:

```bash
npm run post-purchase -- 142.37 Target          # add --account card to charge the card
npm run post-transfer -- savings checking 143
npm run post-paycheck
npm run post-bill -- Vet 220 --in-days 1
npm run jump-days -- 21                         # fast-forward the simulated clock
npm run demo-mode -- on
npm run scenario -- shortfall                   # resets; Maya has $33 and a $143 gap opens at once
npm run reset                                   # everything back, clock and demo mode too
npm run state
```

The rent-week demo: `jump-days 21` (three days before rent; `bill_due_soon` fires), then `post-purchase 900 "Best Buy"` (`forecast_problem` fires and `shortfall` appears), let the Coach propose the transfer, say yes, then `post-transfer savings checking 143` (the watcher completes the proposal).

Switch the optimizer without a redeploy: `POST /admin/plan-version {"version":"v0"}` on localhost.

## When something looks wrong

| Symptom | Check |
|---|---|
| `/health` fails | `pm2 status`, then `pm2 logs finance --lines 50` |
| 401 on `/facts` | the `x-huddlr-secret` header must equal the VM's `HUDDLR_SECRET` |
| Numbers do not move after a CLI action | `npm run state`; confirm the service you are calling is the one behind Caddy |
| Events repeat or never arrive | events are ids; `GET /events` with no `after` returns everything. Agents keep their own cursor |
| `source` is `persona` but Nessie was wanted | `/health` shows `sourceError`: missing key, unknown customer, or Nessie unreachable (plain `http://` times out; use https) |
| Odd plan from the Coach | switch to v0 with `/admin/plan-version`, then tell P1 |
| Time is wrong in some service | they must read the shared `sim_state` row (`DATABASE_URL` set on both finance and agents) |
| Everything is a mess | `npm run reset`, then reset the other services |

## What is tested

- Contract fixtures: with a fresh ledger on 2026-11-07 the engine reproduces `facts.fixture.json` exactly, and the shortfall fixture with checking at $33 and last paid 12 days ago.
- Forecast hand-check on later dates (Nov 21, Nov 28, Jan 15, and a rent-week shortfall), against an independent reference simulation and, for Nov 21, arithmetic. `finance/test/handcheck.test.ts`.
- Optimizer expectations worked out by hand from the persona, plus a property check that lines plus `unallocated` always equal the amount.
- Nessie adapter against a fake that reproduces the real API's quirks, and the real API itself (read-only on Maya, writes on a scratch customer).
- The agents service's own tests run against the in-process stub, so the stub's public shape must not change.

## Known limits

- The forecast uses one average daily spend ($38). It does not learn from the history, so a real spending change shows only through purchases the engine sees.
- Card interest and the car loan accrue nothing; only payments move those balances.
- Goal progress is read from `persona.json` and is not updated when a plan is accepted.
- Nessie keeps whole dollars and cannot store balances or a transfer's destination. The engine keeps exact cents and puts a transfer's route in its description (`savings->checking`).
- A reset of Nessie while `DATA_SOURCE=nessie` is running changes data under the engine; reset first, then let it re-read.
- Car loan and IRA are simulated (the persona's `simulatedFields`), because Nessie does not model them.
- `p2p_imbalance` fires once at start for the persona's friend Alex.
- The ledger is one customer in one file. It is built for the demo, not for many users.
