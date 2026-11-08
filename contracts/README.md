# contracts/

Shared schemas, fixtures, and helpers. This is the one folder everyone reads. **Changes are additive-only** (add fields, never rename or delete) and are announced in chat. Schemas are [zod](https://zod.dev), so the same file gives you TypeScript types and runtime validation.

## Use it from your service

```ts
import { FactsSnapshot, CanIAffordRequest, SimClock, isQuietHours } from "../contracts/src";

const facts = FactsSnapshot.parse(await res.json()); // throws if the shape drifts
```

Run `npm install` inside `contracts/` once (it needs `zod`). `npm test` typechecks everything and checks every fixture against its schema, so a drifting fixture fails CI.

## What is here

| File | What it is | Owner |
|---|---|---|
| `src/facts.ts` | Facts snapshot: accounts, bills, 45-day forecast, 5 indicators, proposals, events, shortfall | P1 |
| `src/events.ts` | Event types, `FinanceEvent`, `makeEventId` | P1 |
| `src/plan.ts` | Plan shape (the Coach's split of a sum of money) | P1 |
| `src/scenarios.ts` | What-if scenarios and result | P1 |
| `src/tools.ts` | Finance service endpoints and the six tool request and response schemas | P1 |
| `src/time.ts` | `SimClock`, `now()`, `jumpDays`, `localDate`, `localHour`, `isQuietHours` | P1 |
| `src/persona.ts` and `persona.json` | The demo customer (Sreyas) used by the seed script and the persona data source | P1 |
| `thresholds.json` | Cushion, big-purchase size, indicator cutoffs | P1 |
| `fixtures/` | Facts (normal and rent-week shortfall), events, plan, what-if, `sim_state` | P1 |
| `src/agents.ts` | Outbox and inbound rows, proposals, `ProposalService` and its HTTP API, `call_requests`, memory rows, reply rules | P2 |
| `p2_agents.sql` | Postgres tables for the above (snake_case, integer cents, numeric ids). Safe to re-run. | P2 |
| `cast.json` | The 6 characters: id, name, emoji, account, personality. P3 formats messages as `<emoji> <name>: <text>`. | P2 |
| `agents-config.json` | Character model, moderator caps, debate budgets, escalation cutoff, safety rules | P2 |

## The clock rule

One database row, `sim_state {offset_seconds, demo_mode}`, and one shared `now()` = real time plus offset.

- **Uses `now()`:** bills, paychecks, forecast, proposal expiry, quiet hours, daily cap, follow-ups, escalation cutoff, transaction dates.
- **Uses the real clock:** typing gaps, retries, timeouts, polling, latency metrics.
- `demo_mode` bypasses quiet hours, relaxes the daily cap, and shortens typing gaps. Emergencies are unaffected.
- The demo controller always lands on daytime simulated times.
- New transactions are detected by ID, never by date.
- Create a `SimClock` over your store, call `await clock.refresh()` once, then `clock.startAutoRefresh()`. Fast-forward with `jumpDays(store, n)`; reset by writing `offsetSeconds: 0`.

## Definitions (so everyone means the same thing)

- **Forecast:** 45 days starting on the customer's local date. Day 0 is today and includes today's spending. For each day, in order: add the paycheck if it is payday, subtract bills due that day, subtract the average daily discretionary spend, record the end-of-day balance.
- **Next payday:** the first payday strictly after today.
- **Safe-to-spend until payday:** lowest end-of-day balance before the next payday, minus the cushion. Negative means short.
- **Shortfall:** present when any forecast day is negative. `within48Hours` means the end of the first negative day is 48 hours or less from `asOf`. `suggestedTransfer` is the shortfall plus the cushion.
- **`can_i_afford` verdict:** `yes` if the lowest balance after the purchase stays at or above the cushion, `tight` if it stays at or above zero but below the cushion, `no` if it goes negative.
- **Indicators:** runway (savings divided by monthly essentials), credit utilization, savings rate (30 days), bill reliability (on-time streak), retirement on track. Status rules are in `facts.ts`, cutoffs in `thresholds.json`.
- **Units:** dollars as plain numbers rounded to cents; dates are local calendar days (`YYYY-MM-DD`); timestamps are ISO instants. Card and loan balances are the amount owed.
- **Event IDs:** derive them from the source record with `makeEventId`, never from the time.

## Boundaries with the agents service (P2)

Both sides agree on these so nothing is guessed at integration time:

- **Auth:** every service-to-service call sends `x-huddlr-secret` with the value of `HUDDLR_SECRET`.
- **Account ids** everywhere are `checking`, `savings`, `card`, `car_loan`, `ira`. Use these in `from_account` and `to_account`, not `credit_card` or `ira_simulated` (those are account *kinds* or labels).
- **Money:** finance contracts use dollars (numbers). P2 stores integer cents. Convert at P2's boundary: `amount_cents = Math.round(amount * 100)`.
- **Plan:** P2 stores P1's `Plan` object verbatim (camelCase: `lines`, `reasonCode`, `reasonNumbers`).
- **Shortfall to `call_requests.shortfall`:** `{ amount_cents: round(shortfall.amount*100), date: shortfall.firstNegativeDate, account: shortfall.accountId }`.
- **Proposal ids:** strings in the finance tools and facts, numbers in the agents database. The finance wrapper converts.
- **One demo user:** the finance tools take no phone number; `DEMO_USER_PHONE` identifies the customer.
- **Quiet hours:** `isQuietHours` uses whole hours (default 22:00 to 08:00). If P2 wants 21:30, either use 22:00 or read the hour and minute from `localDate`/`localHour` yourself.

## Fixtures

The fixtures are the expected output of the engine for the demo persona, so P1's forecast and indicator tests can compare against them, and P2, P3, and P4 can build against real shapes before the engine exists.

- `facts.fixture.json`: Nov 7 morning, no shortfall. Lowest balance before payday is $537.50 on Nov 19; safe-to-spend is $437.50.
- `facts.shortfall.fixture.json`: Dec 2 morning, rent week. $43 short on Dec 3, a $143 Savings-to-Checking proposal pending. Use it for the escalation and emergency-call paths.
- `plan.fixture.json`: a $600 bonus split three ways. The **shape** is the contract; the amounts are illustrative until the optimizer lands.
- `what_if.fixture.json`: "lose income for 2 months" goes negative in 18 days. The indicator changes are illustrative.
- `events.fixture.json`: one of each main event type.
