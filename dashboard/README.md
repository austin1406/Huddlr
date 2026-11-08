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

## Next

- Demo controller panel (H17-19): purchase / paycheck / bill / user transfer, fast-forward, demo mode, reset, using P1's `/admin/*`
