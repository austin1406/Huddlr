# scripts/

CLI helpers shared across the team.

- `seed/`: builds the Nessie demo customer from `contracts/persona.json` (safe to re-run, with a reset mode)
- Demo helpers wrap the finance scripts: post purchase, post transfer, jump days, reset

Each service exposes its own `reset`; `reset-all` calls them all.
