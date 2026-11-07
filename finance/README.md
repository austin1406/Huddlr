# finance/

Plain-code finance engine. No AI here: every number the characters say comes from this folder.

Owner: Austin Santhakumar (@austin1406), P1

- 45-day forecast, 5 health indicators, plan optimizer, what-if simulator, shortfall flag
- Nessie seed data source and sync (new items detected by ID)
- Tool API served at stable URLs, with a stub that returns fixtures until the real logic lands
- CLI scripts by H8: `post-purchase`, `post-transfer`, `post-paycheck`, `post-bill`, `jump-days N`, `reset`
- The engine takes an `asOf` date from the shared `now()` and never reads the real clock for calendar logic

## The stub (live now)

`finance/` currently serves the contract fixtures at the real URLs, so everyone can build against port 4000 before the engine exists. Every response carries the header `x-huddlr-data: fixture`. `can_i_afford`, `what_if` (purchase_now) and plan v0 are real logic over the fixture forecast; the other what-if scenarios return the fixture shape.

```bash
cd finance && npm install && npm run dev      # http://localhost:4000
npm test                                      # typecheck + 16 tests, responses validated against contracts/
```

Auth: send `x-huddlr-secret: $HUDDLR_SECRET` on everything except `GET /health`. If `HUDDLR_SECRET` is unset, auth is off (local only).

| Endpoint | Notes |
| --- | --- |
| `GET /health` | open |
| `GET /facts` | `?scenario=normal\|shortfall` to pick a fixture per request |
| `GET /events` | `?after=<eventId>&limit=50`, oldest first |
| `POST /tools/get_snapshot`, `can_i_afford`, `what_if`, `get_plan`, `get_pending_proposal`, `accept_proposal` | bodies per `contracts/src/tools.ts`; 400 `invalid_request` on a bad body |

Stub-only controls (not routed by Caddy, use from the VM or locally):

- `GET/POST /admin/scenario` `{ "scenario": "shortfall" }` switches what `/facts` and the tools return, and resets state
- `POST /admin/events` adds a `FinanceEvent` (deduped by id)
- `POST /admin/reset` restores events and the pending proposal

Shortfall scenario: `get_pending_proposal` returns `prop_demo_1`; `accept_proposal` accepts it once, then reports `already_accepted`.

Deploy on the VM: `finance/deploy/deploy.sh` (pm2 process `finance`, behind Caddy at `/facts*` and `/tools/*`).
