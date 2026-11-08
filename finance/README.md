# finance/

Plain-code finance engine. No AI here: every number the characters say comes from this folder.

Owner: Austin Santhakumar (@austin1406), P1

- 45-day forecast, 5 health indicators, plan optimizer, what-if simulator, shortfall flag
- Nessie seed data source and sync (new items detected by ID)
- Tool API served at stable URLs (`FINANCE_MODE=engine`, the default; `FINANCE_MODE=stub` serves the contract fixtures only)
- CLI scripts by H8: `post-purchase`, `post-transfer`, `post-paycheck`, `post-bill`, `jump-days N`, `reset`
- The engine takes an `asOf` date from the shared `now()` and never reads the real clock for calendar logic

## The engine (default)

The engine runs Maya's persona as a simulated customer. Nothing is faked per request: it keeps a ledger, and every answer is computed from it.

- **Forecast:** 45 days from today. Each day: paycheck if payday, bills due, then the average daily spend; record the end-of-day balance. Safe to spend = lowest balance before the next payday minus the $100 cushion.
- **Indicators:** runway, credit utilization, savings rate, bill reliability, retirement on track, each with the raw numbers and thresholds from `contracts/thresholds.json`.
- **Clock:** every calendar decision uses `now()` = real time + the `sim_state` offset. Days that pass are settled when anything next reads: paychecks land, bills are paid (rent, car loan and the card minimum also pay down those balances), daily spending posts. A bill paid while checking is overdrawn counts as late and resets the on-time streak.
- **Events:** detected from the ledger by source id, never by date, so nothing repeats: `paycheck_landed`, `big_purchase` (over $75), `bill_due_soon` (3 days), `forecast_problem` (negative balance within 14 days), `user_transfer_seen`, `p2p_imbalance`. **Transfer watcher:** when a `user_transfer_seen` is detected, it looks for an open proposal (pending or accepted, read from the shared `proposals` table) with the same accounts and an amount no larger than the transfer, then calls the agents service's `complete` endpoint with the transfer id. The event's `matchedProposalId` and `txnId` record the result. If the agents service does not answer, the transfer is retried every 15 seconds until it does. Finance never writes the proposals table.
- **What-if:** all four scenarios run against a copy of the ledger.
- **Plan optimizer (`get_plan`):** v1 by default. In order, each step taking only what it needs: cover a shortfall plus the cushion; capture the unclaimed employer match; pay debt above 8% APR, highest first; build the emergency fund to 1 month of essentials; fund goals; build it to 3 months; then split the rest between extra retirement (up to the target) and extra payments on remaining debt. Anything no step can use is `unallocated`. `PLAN_VERSION=v0` or `POST /admin/plan-version {"version":"v0"}` switches back to the simple rules live. Goal progress comes from `persona.json` and is not updated by accepted plans. Lost income also drops the savings rate to -100%.
- **Proposals:** `get_pending_proposal` and `accept_proposal` forward to the agents service (`AGENTS_URL`, default `http://localhost:5000`). If it does not answer, nothing is pending and accept changes nothing.
- **State:** ledger and event log are saved to `finance/.data/` (git-ignored) and survive restarts. The `sim_state` row is stored in Postgres when `DATABASE_URL` is set (the agents service reads it from there); otherwise in `finance/.data/sim_state.json`, which only this service can see.
- **Fixture parity:** with a fresh ledger on 2026-11-07 the engine reproduces `contracts/fixtures/facts.fixture.json` exactly, and the shortfall fixture with `checking 33, last paid 12 days ago`. A test fails if either drifts.

### Transaction log (Nessie)

`DATA_SOURCE=nessie` makes Nessie the transaction log (default `persona` changes nothing). The engine keeps its own ledger and balances because Nessie cannot hold them (see `docs/nessie.md`). What it does:

- Reads everything at start as history, then applies any record id it has not seen, at most every 30 seconds.
- Writes CLI and dashboard actions to Nessie first (whole dollars, status and dates included), then applies them with exact cents. Nothing is applied twice.
- Stays up on the persona if Nessie is unreachable; `GET /health` shows `source` and `sourceError`, `GET /admin/state` shows records seen.
- Env: `NESSIE_API_KEY`, `NESSIE_BASE_URL` (default `https://api.nessieisreal.com`), `NESSIE_CUSTOMER` (default the persona's name).

### Demo controls

Run from `finance/` against the running service (`FINANCE_ADMIN_URL`, default `http://localhost:4000`; `/admin` is not routed by Caddy, so run these on the VM, or call the same routes from the demo controller on localhost).

```bash
npm run post-purchase -- 142.37 Target --category shopping     # add --account card to charge the card instead
npm run post-transfer -- savings checking 143
npm run post-paycheck                                          # lands a paycheck now; the next one is 14 days later
npm run post-bill -- Vet 220 --in-days 1                       # or --date 2026-12-05, --nonessential
npm run jump-days -- 21                                        # fast-forward the simulated clock
npm run demo-mode -- on
npm run scenario -- shortfall                                  # resets, then Maya has $33 and a $143 gap opens
npm run reset                                                  # everything back to the start, clock and demo mode too
npm run state                                                  # balances, clock, recent transactions
```

HTTP routes behind them: `GET /admin/state`, `POST /admin/purchase | transfer | paycheck | bill | scenario | reset | events | plan-version`, `POST /admin/sim/jump-days | demo-mode`.

Typical "rent week" demo: `npm run jump-days -- 21` (3 days before rent, `bill_due_soon` fires), then `npm run post-purchase -- 900 "Best Buy"` (`forecast_problem` fires and `shortfall` appears in `/facts`).

## Testing

```bash
cd finance && npm install && npm run dev      # http://localhost:4000
npm test                                      # typecheck + tests; every response is parsed with the contract schemas
```

Auth: send `x-huddlr-secret: $HUDDLR_SECRET` on everything except `GET /health`. If `HUDDLR_SECRET` is unset, auth is off (local only). Every response carries `x-huddlr-data: engine` (or `fixture` in stub mode).

| Endpoint | Notes |
| --- | --- |
| `GET /health` | open |
| `GET /facts` | in stub mode, `?scenario=normal\|shortfall` picks a fixture per request |
| `GET /events` | `?after=<eventId>&limit=50`, oldest first |
| `POST /tools/get_snapshot`, `can_i_afford`, `what_if`, `get_plan`, `get_pending_proposal`, `accept_proposal` | bodies per `contracts/src/tools.ts`; 400 `invalid_request` on a bad body |

## The stub

`FINANCE_MODE=stub` serves the contract fixtures at the same URLs, with the same admin routes for switching the fixture (`POST /admin/scenario`), injecting events (`POST /admin/events`) and resetting. The shortfall fixture has a pending proposal `prop_demo_1`. The engine-only routes (purchase, transfer, jump-days and so on) answer 501.

Deploy on the VM: `finance/deploy/deploy.sh` (pm2 process `finance`, behind Caddy at `/facts*` and `/tools/*`).
