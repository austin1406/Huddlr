# Huddlr

Your bank accounts as a group chat. Checking, Savings, Credit Card, Car Loan, and IRA each speak
for their own account over iMessage and phone calls, argue from real numbers, and a Coach settles
every debate with a concrete plan.

**The AI can talk, but it can't move your money.**

Built for HackUTD 2026 (ZeroDay). Synthetic data only. Status: in progress.

## Tracks

- 360° Financial Health Navigator
- Photon 2.0 messaging agent (iMessage text and voice calls)
- Capital One Nessie is the bank-data sandbox behind it (final track entries to be confirmed with organizers)

## How it works

```
Nessie (seeded) -> sync/event detector -> database -> finance engine (plain code)
   -> moderator -> character agents (LLM) -> number checker -> outbox
   -> Photon iMessage (text + images)
Voice: agent on a Photon SMS number (SIP); tools call the finance engine;
       post-call recap goes to iMessage through the outbox.
Dashboard (read-only) <- database.
```

## Planned features

- Seeded demo customer, Nessie sync, and event detection
- Finance engine: 45-day forecast, 5 health indicators, optimizer, what-if simulator, shortfall flag
- Cast of 6 characters with a moderator and 2-round debates that end in the Coach's plan
- Proposals the user approves (the agents never move money), with expiry and follow-ups
- iMessage text and images, plus a dashboard
- Voice: call-in "ask" line, emergency outbound call, optional monthly recap

## Repo layout

| Folder | What lives here | Owner |
|---|---|---|
| `contracts/` | Shared schemas, fixtures, the clock helper. Additive changes only. | everyone |
| `finance/` | Forecast, indicators, optimizer, what-if, Nessie sync, tool API | TBD (P1) |
| `agents/` | Moderator, characters, number checker, proposals, memory | TBD (P2) |
| `photon/` | iMessage webhook, outbox sender, image cards | TBD (P3) |
| `dashboard/` | Read-only dashboard and demo controller | TBD (P3) |
| `voice/` | Voice agent, call webhooks, seed script | TBD (P4) |
| `scripts/` | CLI helpers (seed, post purchase, jump days, reset) | shared |
| `docs/` | Timeline, runbooks, metrics | everyone |

## Getting started

1. Accept the repo invitation.
2. Clone **outside OneDrive** (for example `C:\dev`), because OneDrive syncing `node_modules` and `.git` causes problems.
3. Copy `.env.example` to `.env` and fill in the keys the team shares privately.
4. **Never commit `.env` or any key.** If a key is ever committed, rotate it immediately.
5. Read [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) before your first push.

## Safety rules

- No money movement. Agents propose, the user acts in their own bank.
- Every number comes from code. The language model only phrases things.
- Quiet by default: capped messages, quiet hours, an evening digest.
- An unclear answer counts as "no".
- Agents never ask for passwords, codes, or account numbers.

## Simulated

The IRA, card APR and limit, and fast-forwarded time are simulated. All customer data is synthetic.

## License

MIT
