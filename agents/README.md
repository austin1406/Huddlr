# agents/

The cast: moderator, six characters, number checker, proposals, memory.

Owner: Sreyas Chakka (@sreyas-chakka), P2

- Moderator: at most 3 speakers, quiet hours, daily cap, evening digest
- Debates: positions and the Coach's plan generated in parallel; budget of about 5 seconds to the first message and 15 to the plan
- Number checker: every number must come from the facts, otherwise retry once (if time allows) or use a template
- `ProposalService`: the single code path for accept, decline, expire, and mark completed. Text, voice, and the finance watcher all call it.
- Memory shared across text and voice
- Writes outbox rows only; never talks to Photon directly

## Run it

```bash
cd agents && npm install
npm test                       # typecheck + all tests (no key needed)
npm run harness -- --fake      # full reaction with a fake model that invents "$63" so you see the checker catch it
npm run harness                # same with real Gemini (GEMINI_API_KEY in ../.env)
npm run harness -- --event forecast_problem --fixture shortfall --runs 10
```

- `src/checker.ts`: number checker. Each character is checked against its own slice of the facts (plus the plan for the Coach).
- `src/character.ts`: prompt, Gemini call, retry once if time allows, grounded template fallback.
- `src/moderator.ts`: who speaks (max 3, Coach last on plan events), quiet hours, daily cap, digest, emergencies bypass both.
- `src/harness.ts`: Gate 0 harness. Exit code 1 if any ungrounded number would be sent.
