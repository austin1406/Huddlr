# voice/

Phone calls on a Photon SMS number (SIP) with a voice agent.

Owner: Rishi Vallabhaneni (@rishivallabhaneni), P4

- Call-in "ask" line using the finance tools, with the option to ask for a character by name
- Emergency outbound call from `call_requests`, with a text fallback
- Optional monthly recap call (`monthly_recap`)
- Post-call webhook: saves the summary to `calls` and writes a recap row to the outbox
- The caller allowlist is a demo convenience, not security. The real safety rule is that the AI can't move money.
- Setup notes and the runbook go in `docs/voice.md`

## Run

```bash
npm install
npm run dev            # http://localhost:8790
npm test               # typecheck + unit tests
npm run agent-config   # prints the ElevenLabs prompt, tools, and webhook URLs (contains the secret, don't commit)
```

## Endpoints

| Route | Called by | Does |
|---|---|---|
| `GET /voice/health` | anyone | `{ ok: true }` |
| `POST /voice/context` | ElevenLabs conversation-initiation webhook | Returns dynamic variables (first name, date, pending proposal, recent events, goals) from P1's `/facts` and P2's `memory_facts`. Checks `x-huddlr-secret`. |
| `POST /voice/post-call` | ElevenLabs post-call webhook | Verifies the `ElevenLabs-Signature` HMAC, saves to `calls` and `memory_messages`, writes a recap row to `outbox` (idempotent on the conversation id). |

The agent's tools call P1's `/tools/*` directly with the `x-huddlr-secret` header (see `src/tools.ts`).

## Safety

- The recap uses ElevenLabs' summary only if every number in it appeared in a tool result during the call. Otherwise it sends a template with no numbers.
- An accepted proposal is recorded only from a successful `accept_proposal` tool result. The recap says the transfer is the user's to make.
- If `/facts` is down, the call still starts, just without context.

## Files

- `src/prompt.ts`: system prompt and first message
- `src/tools.ts`: ElevenLabs webhook tool definitions
- `src/context.ts`: call-start variables
- `src/postCall.ts`: signature check, payload parsing, grounded recap
- `src/db.ts`: writes to P2's tables, reads `sim_state` for `now()`
