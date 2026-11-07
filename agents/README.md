# agents/

The cast: moderator, six characters, number checker, proposals, memory.

Owner: Sreyas Chakka (@sreyas-chakka), P2

- Moderator: at most 3 speakers, quiet hours, daily cap, evening digest
- Debates: positions and the Coach's plan generated in parallel; budget of about 5 seconds to the first message and 15 to the plan
- Number checker: every number must come from the facts, otherwise retry once (if time allows) or use a template
- `ProposalService`: the single code path for accept, decline, expire, and mark completed. Text, voice, and the finance watcher all call it.
- Memory shared across text and voice
- Writes outbox rows only; never talks to Photon directly
