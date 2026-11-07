# Voice

Owner: P4. Setup notes, findings, and the runbook for phone calls.

## Status

| Item | Status | Notes |
|---|---|---|
| SMS number purchased | not started | |
| Default SIP voice profile | not started | |
| ElevenLabs agent created | not started | Model: TBD |
| Number imported into ElevenLabs (TLS, per Photon cookbook) | not started | |
| Inbound test call, audio both ways | not started | |
| Outbound credentials + test call | not started | |

**Gate 0 (H3):** an inbound and an outbound call both work. No number by H3 means voice is cut.

## Environment

| Variable | Where it comes from |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard |
| `ELEVENLABS_AGENT_ID` | The agent's settings page |
| `VOICE_TOOL_SECRET` | Shared secret the agent sends to P1's tool endpoints |
| `PUBLIC_BASE_URL` | P3's fixed domain; every webhook and tool URL uses it |

## Agent tools

All point at `PUBLIC_BASE_URL` with the shared secret. Final shapes come from P1's contracts.

- `get_snapshot`
- `can_i_afford(amount)`
- `what_if(scenario)`
- `get_plan(amount)`
- `get_pending_proposal`
- `accept_proposal(id)`: only on a clear yes

## Agent prompt rules

- Short answers. Only numbers that came from a tool result.
- Never asks for passwords, codes, or account numbers.
- Offers a text follow-up.
- The caller allowlist is a demo convenience, not security, since caller ID can be faked.

## Findings

_Record what worked, what broke, and latency here._

## Runbook

_To fill in by H14:_ test call, rotate outbound password, SIP 403 and 407, allowed countries.
