# dashboard/

The "under the hood" view for judges and the team. Users never see it: it shows the math behind every message.

Owner: P3

- **Header:** customer, simulated time, outbox queue (sent / waiting / held / failed), live vs fixture data
- **Accounts:** balances, card APR and limit, loan payment, simulated IRA
- **Health indicators:** the 5 gauges with their good/concern thresholds and owning character
- **45-day forecast:** checking balance by day, cushion, zero line, lowest point, first negative day, paydays, bill dots (hover)
- **Proposals:** latest proposals and their status; **Event log:** P1's recent events
- **iMessage thread:** live mirror of the demo user's conversation (user on the right, cast on the left; waiting/held messages are dimmed)

Refreshes every 2.5 s from `GET /api/state` (P1's `/facts` + the shared DB). Phone numbers are masked.

## Run

```bash
npm install
DASHBOARD_FIXTURE=1 npm run dev     # local preview on sample data → http://localhost:3001
```

On the VM: `bash /opt/huddlr/dashboard/deploy/deploy.sh`, then open the domain root.
It's behind a login (user `huddlr`, password `DASHBOARD_PASSWORD` in `/opt/huddlr/.env`; the deploy script creates one and prints it) because it shows real conversations.

Env (shared `/opt/huddlr/.env`): `DATABASE_URL`, `FINANCE_URL`, `HUDDLR_SECRET`, `DEMO_USER_PHONE`, `DASHBOARD_PASSWORD`, optional `DASHBOARD_PORT` (3001).

## Demo controls (top panel)

| Control | What it does |
|---|---|
| **+1 / +3 / +7 days** | Fast-forward the shared clock. Always lands in daytime (9:00-20:59 local); otherwise moves on to 10:00, so quiet hours never silence the demo |
| **demo mode** | Turns off quiet hours, relaxes the daily cap, shortens typing gaps (emergencies unaffected) |
| **Quick events** | Chipotle $14, Target $142 (card), TV $400 (checking), paycheck, **rent $1,100 due tomorrow** (creates a shortfall → warning → emergency call), Savings → Checking $200 (the user's own transfer; the watcher completes a matching proposal) |
| **Purchase / Transfer / Bill** | Custom amounts |
| **⟲ reset demo** | Finance back to the start (world + clock), then agents (conversation, proposals, outbox). Keeps who has texted the line, so the demo phone still works |
| **hide** | Collapses the panel for a clean projector view (remembered per browser) |

The buttons call `POST /api/control/:action` on the dashboard (same login), which calls P1's `/admin/*` and P2's `/agents/reset` **on localhost** with the shared secret. The secret never reaches the browser, and `/admin/*` is not public (Caddy returns 404).
