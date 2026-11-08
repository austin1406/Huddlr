# Voice

Owner: P4 (Rishi). Setup notes, findings, and the runbook for phone calls. Code lives in `voice/` (see its README).

## Status

| Item | Status | Notes |
|---|---|---|
| SMS number purchased | done | +1 (828) 647-2114, on the Default voice profile. Shared iMessage lines can't take calls, so voice needs this number. |
| Default SIP voice profile | done | Inbound destination `sip:+18286472114@sip.rtc.elevenlabs.io:5061`, transport TLS, no SIP auth. Outbound credential = the profile's SIP username/password (digest SHA-256 works) |
| ElevenLabs agent created | done | "Huddlr Coach", `agent_0701m6w7dzcvfj4rky8zejyee2we`, created by `npm run setup:elevenlabs`. LLM default gemini-2.0-flash |
| Number imported into ElevenLabs (TLS) | done | `phnum_3701m6w7e19mf4b95b4jgpnpn0s3`, outbound to `sip.photon.codes` TLS (5061) with the Default profile's SIP username/password (`PHOTON_SIP_USERNAME`/`PHOTON_SIP_PASSWORD`); re-apply with `npm run setup:elevenlabs -- --update-number`. If outbound gets 401/407, switch the profile's digest from SHA-256 to MD5, assigned to the agent |
| Inbound test call, audio both ways | done | 2026-11-07: "Hey Maya" greeting, can_i_afford and get_snapshot with real numbers. The server needs DEMO_USER_PHONE set, or the allowlist hides details |
| Outbound credentials + test call | done | 2026-11-07: ElevenLabs outbound-call API → `sip.photon.codes` TLS → rang the demo phone, audio both ways |
| Voice service code (context, post-call, emergency call) | done | merged in #6, #7 |
| Tools checked against P1's stub | done | all six return 200 with the agent's request shapes |

**Gate 0 (H3):** an inbound and an outbound call both work. **Passed 2026-11-07.**

**Post-call recap: working.** After a call the summary arrives in the iMessage thread. If it stops: check `pm2 logs voice` for "no DATABASE_URL" or a 401 (webhook secret), then the `outbox` row status. The sender only texts phones that have texted the Huddlr line first.

## Fast path: setup script

Fill `ELEVENLABS_API_KEY`, `PUBLIC_BASE_URL`, `HUDDLR_SECRET`, `VOICE_PHONE_NUMBER`, `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` in `.env`, then:

```bash
cd voice
npm run setup:elevenlabs -- --dry-run   # check, sends nothing
npm run setup:elevenlabs                # creates secret, 6 tools, post-call webhook, agent, SIP number
```

It writes `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, and `ELEVENLABS_WEBHOOK_SECRET` into `.env` without printing them. After a prompt change: `npm run setup:elevenlabs -- --update`. Then set the Photon Default profile's destination (step 5 below) and deploy.

## Setup by hand, in order

1. **Photon:** buy the SMS number, add the default SIP voice profile.
2. **ElevenLabs:** create an agent. Run `cd voice && npm run agent-config` and copy in:
   - `first_message` (it's `{{opener}}`) and `system_prompt`
   - the six `tools` (webhook type, POST, with the `x-huddlr-secret` header; store the secret as an ElevenLabs secret)
3. **ElevenLabs agent security settings:** enable "Fetch initiation client data from webhook" with URL `https://<domain>/voice/context` and the `x-huddlr-secret` header. Allow dynamic variables.
4. **ElevenLabs workspace webhooks:** post-call webhook to `https://<domain>/voice/post-call`, transcription events on. Copy its HMAC secret into `ELEVENLABS_WEBHOOK_SECRET`. Also enable call initiation failure events if offered.
5. **Import the Photon number** into ElevenLabs (Phone Numbers, SIP trunk, TLS) following Photon's cookbook exactly. Assign it to the agent. Copy the number's id into `ELEVENLABS_PHONE_NUMBER_ID`.
6. **VM:** fill `.env` (`ELEVENLABS_*`, `HUDDLR_SECRET`, `DATABASE_URL`, `DEMO_USER_PHONE`), then `/opt/huddlr/voice/deploy/deploy.sh`. Check `https://<domain>/voice/health`.
7. **Test:** call the number from the demo phone and ask "can I afford a forty dollar dinner tonight?". Then insert an emergency `call_requests` row (SQL in `voice/README.md`) and let it ring.

## Environment

| Variable | Where it comes from |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs, profile, API keys |
| `ELEVENLABS_AGENT_ID` | The agent's settings page |
| `ELEVENLABS_PHONE_NUMBER_ID` | ElevenLabs Phone Numbers page, after importing the Photon number |
| `ELEVENLABS_WEBHOOK_SECRET` | ElevenLabs workspace webhook settings (HMAC) |
| `HUDDLR_SECRET` | Team secret; sent as `x-huddlr-secret` by the tools and the context webhook |
| `PUBLIC_BASE_URL` | P3's fixed domain; Caddy routes `/voice/*` to port 6000 |
| `DEMO_USER_PHONE` | The demo phone, E.164 |
| `VOICE_OPTED_IN_NUMBERS` | Numbers we may call (default: demo phone) |
| `VOICE_ALLOWED_CALLERS` | Inbound callers who get account details (default: opted-in numbers; `*` for anyone) |

## Agent tools

All point at `PUBLIC_BASE_URL/tools/*` with the shared secret. Shapes come from `contracts/src/tools.ts`.

- `get_snapshot`, `can_i_afford(amount)`, `what_if(scenario)`, `get_plan(amount)`, `get_pending_proposal`
- `accept_proposal(proposalId, via: "voice")`: only on a clear yes

## Safety

- Numbers only from tool results or code-built context. The text recap drops the AI summary if it has a number no tool returned.
- The agent never asks for passwords, codes, or account numbers, and can't move money.
- **The caller allowlist is a demo convenience, not security:** caller ID can be faked, and the tools themselves don't know who is calling. Unknown callers get a no-details greeting and a prompt rule not to call tools.
- Outbound calls only go to opted-in numbers. Only emergencies call during quiet hours.

## Findings

### Tool latency (P1 stub on localhost, 20 calls each)

| Tool | Median | p95 |
|---|---|---|
| get_snapshot | 1ms | 3ms |
| can_i_afford | 0ms | 1ms |
| what_if | 0ms | 1ms |
| get_plan | 0ms | 1ms |
| get_pending_proposal | 0ms | 1ms |
| accept_proposal | 0ms | 1ms |

Re-run against the deployed domain with `npm run latency -- 20` (adds network time). End-to-end call latency (caller stops talking to agent starts) still needs 3-5 real calls:

| Call | Question | Latency | Recap delay | Notes |
|---|---|---|---|---|
| 1 | "Can I afford a $40 dinner?", balances, "what is the $437?" | LLM first token ~0.65s per turn; ~4s from question to answer on tool turns | not checked | All numbers matched the tools (437.50 safe to spend, 5 balances, payday Nov 20) |
| 2 | | | | |
| 3 | | | | |

### Still to confirm on real calls

- Payload shape of ElevenLabs `call_initiation_failure` (busy, no answer).
- Whether ElevenLabs can switch voices mid-call. If not, keep one voice that says "Savings here:".

## Runbook

| Problem | Check |
|---|---|
| Call doesn't connect at all | Number assigned to the agent in ElevenLabs? Photon SIP profile active? TLS chosen on import? |
| SIP 403 | Outbound credentials wrong or the destination country isn't allowed. Re-enter the SIP username/password from Photon. |
| SIP 407 | Auth challenge failed: the SIP password in ElevenLabs is stale. Rotate it in Photon, paste the new one in ElevenLabs. |
| Agent says "I don't know" for every number | Tools can't reach finance: `curl https://<domain>/facts -H "x-huddlr-secret: ..."`. Check the secret in the ElevenLabs tool headers. |
| Agent greets with `{{opener}}` literally | The initiation webhook failed. Check `/voice/health` and the context webhook URL/header in ElevenLabs. |
| No recap text after a call | `pm2 logs voice`: a 401 means `ELEVENLABS_WEBHOOK_SECRET` is wrong. Then check the outbox row status (P3's sender). |
| Emergency row stays `pending` | Voice service needs `DATABASE_URL`; check `VOICE_OUTBOUND` isn't `off`, and the phone is in `VOICE_OPTED_IN_NUMBERS`. |
| Emergency row ends `cancelled` | The number isn't opted in. |
| Make a test call | Call the Photon number from the demo phone, or insert an emergency row (SQL in `voice/README.md`). |
| Restart | `pm2 restart voice --update-env` |
