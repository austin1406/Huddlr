# Nessie spike (P1)

Tested 2026-11-08 against the real API with the team key, using a throwaway customer and only per-id deletes. Everything below was observed, not read from docs. Re-run the checks if the API behaves differently.

## Verdict

**Nessie cannot be our source of balances.** No write changes any balance, and transfers cannot record a destination. Nessie works as the **transaction log**; the finance engine keeps its **own ledger** (the mirror the plan called for). Custom dates are accepted, so history and "today's" transactions can carry simulated dates.

## Connection

| | |
|---|---|
| Base URL | `https://api.nessieisreal.com`. **Plain `http://` times out**; set `NESSIE_BASE_URL` to the https URL (the seed script's default is http). |
| Auth | `?key=<NESSIE_API_KEY>` on every request. A wrong path answers `403 {"message":"Missing Authentication Token"}`, so that also means "no such route". |
| Scope | `/customers`, `/accounts`, `/merchants` are per key and were **empty** before the spike. `/enterprise/customers` is global (about 8,600 customers from everyone). |
| Speed | 70 to 400 ms per call. Not rate limited at about 60 calls. Pagination not seen (lists return plain arrays). |

## What each write needs

Validation is strict (extra fields are rejected). Required fields:

| Create | Body |
|---|---|
| Customer | nothing is required, so `{}` creates an **empty customer**. Always send `first_name`, `last_name`, `address`. |
| Account `POST /customers/{id}/accounts` | `type` (`Checking`, `Savings`, `Credit Card`), `nickname`, `rewards`, `balance` |
| Merchant | `name`; `category` must be **one string**, not an array |
| Purchase `POST /accounts/{id}/purchases` | `merchant_id`, `medium` (`balance`), `amount`, and **always `status: "completed"`** (see below); optional `purchase_date`, `description` |
| Deposit | `medium`, `transaction_date`, `status`, `amount`, `description` |
| Withdrawal | `medium`, `amount` (optional `transaction_date`, `status`, `description`) |
| Transfer `POST /accounts/{from}/transfers` | `transaction_date`, `status`, `amount`, `description` **only**. `medium`, `payee`, `payee_id`, `to_account_id` and similar are all rejected, and none of them work as query parameters either. |
| Bill | `status`, `payee`, `payment_amount`, and **always `payment_date` and `recurring_date`** (see traps); optional `nickname`, `recurring_date`. `creation_date` is rejected (the server sets it). |

## Answers to the spike questions

1. **Do balances update?** No. A $50 purchase, $200 deposit, $10 withdrawal and $25 transfers left the account `balance` unchanged. Account balance is just the number given at creation.
2. **Custom transaction dates?** Yes. Past and future `purchase_date` and `transaction_date` were accepted and stored.
3. **Can a transfer name its destination?** No. It is recorded against the sending account only, and the receiving account's transfer list is empty (404). A transfer in lists shows `id` (not `_id`) with just date, status, amount, description. Convention for us: put the route in `description`, for example `savings->checking`.
4. **Reads:** `GET /accounts/{id}/purchases|deposits|transfers|bills`, `GET /customers/{id}/accounts`, `GET /accounts/{id}`. List endpoints return `404` when empty for transfers, `200 []` for the others.

## Traps

- **A purchase created without `status` poisons the list.** It is stored, but `GET /accounts/{id}/purchases` then fails with `400 ... Purchase status field required` for that whole account. Individual purchases cannot be deleted (no route). Always send `status: "completed"`.
- **Nessie stores whole dollars.** Found by Rishi when seeding: a balance of 1186.50 came back as 1186, and cents on purchases are dropped. Amounts sent to Nessie must be whole dollars. The finance ledger keeps cents itself, so a $142.37 purchase is exact in the engine and rounded in Nessie. The golden test compares totals built from whole-dollar data.
- **A bill without `payment_date` or `recurring_date` poisons the bill list**, the same way a purchase without `status` poisons purchases: stored, then `GET /accounts/{id}/bills` fails with `400 ... field required` for the whole account (`upcoming_payment_date` is derived from them). Always send both, also with `status: recurring`. `recurring_date` is the day of month. Found live while testing the engine's bill write; per-id delete of the bad bill fixes the list.
- **No per-id delete** for purchases, withdrawals, merchants or customers. Per-id delete works for deposits, transfers, bills and accounts. A bulk `DELETE /data?type=...` exists in the seed client (not tested here).
- Creating an account does not link anything else; an account's purchase list needs a real `merchant_id`, so create merchants first.

## Left behind by the spike

Two customers (one is empty), one merchant ("Spike Merchant"), three purchases and one withdrawal, all on deleted accounts. Harmless, and the seed script's reset mode clears them.

## Design: NessieSource over our own ledger

The finance engine already runs on an in-process ledger (`finance/src/engine/ledger.ts`). Nessie plugs in as the **source of transactions**, not balances:

1. **Baseline:** accounts and 60 days of history are seeded into Nessie (`scripts/seed`). On first sync the engine records every existing Nessie transaction id as history and does **not** apply them. Starting balances come from the persona, which matches what the seed wrote as each account's `balance`.
2. **Sync:** poll every 30 to 60 seconds. Any transaction id the engine has not seen is **new**: apply it to the ledger and let the event detector run (`big_purchase`, `paycheck_landed`, `user_transfer_seen`). New items are found by id, never by date.
3. **Mapping:** purchase on checking or card; deposit with description `Paycheck`; transfer by the `from->to` convention in `description`; bill with `status: completed`.
4. **Writes:** the CLI scripts post to Nessie with the simulated date and `status: completed`, then the next sync applies them. No double counting, because applied ids are remembered.
5. **Golden test:** persona-derived facts equal Nessie-derived facts for the same data.

## Fixes the seed script needs

`scripts/seed/seed.ts` as of 2026-11-08 would fail or poison the sandbox:

- Default base URL is `http://api.nessieisreal.com`, which times out. Use https.
- Purchases are sent **without `status`**, which breaks the purchase list for the account. Add `status: "completed"`.
- Deposits are sent without `status`, which is rejected (400). Add `status: "completed"`.
- Bills need a `payment_date` and a `recurring_date` (the seed's bills have both), and amounts must be whole dollars (fixed in PR #37). Customers should keep sending a name and address.
- Reseeding needs `seed:reset` (bulk delete on the shared key). Safe while the finance engine does not read Nessie yet; after NessieSource is switched on, resetting changes data under it, so reset first and sync after.

## NessieSource (built)

`finance/src/nessie/` implements the design above. Turn it on with `DATA_SOURCE=nessie` (needs `NESSIE_API_KEY`; `NESSIE_BASE_URL` defaults to the https URL; `NESSIE_CUSTOMER="First Last"` overrides the persona name). The default is `persona`, which changes nothing.

- The first read after start (or after a reset) is recorded as history and applies nothing. Records that appear later are applied by id.
- The engine reads Nessie at most every 30 seconds, and a background timer reads it about every 45 seconds, so changes made in Nessie by hand become events without anyone asking.
- Actions through the CLI or dashboard controller are written to Nessie first (whole dollars, with a status and all required dates; the route of a transfer goes in its description as `savings->checking`), then applied to the ledger with the exact cents. The next read does not apply them again.
- If Nessie is unreachable at start, the engine runs on the persona alone and `/health` shows `sourceError`. If it goes down later, the engine keeps its ledger; actions are applied locally only.
- Verified live on 2026-11-08: Maya's 77 records (54 purchases, 5 paychecks, 18 bills) are read as history with no change to the facts; purchase, transfer, paycheck and bill writes each read back correctly on a scratch customer.

Left behind by that test (cannot be deleted per id): customers "Cents Scratch" and "Zed Scratch", and two orphaned purchases. Harmless.
