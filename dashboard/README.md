# dashboard/

Read-only dashboard and the demo controller.

Owner: TBD (P3)

- Dashboard: 5 indicator gauges, 45-day forecast chart, chat mirror, event log, proposal status
- Demo controller: wraps the finance CLI scripts (post purchase, paycheck, bill, user transfer), fast-forwards time (always landing on daytime), toggles `demo_mode`, and runs `reset-all`
- Transactions are dated with the shared `now()`
