# voice/

Phone calls on a Photon SMS number (SIP) with a voice agent.

Owner: Rishi Vallabhaneni (@rishivallabhaneni), P4

- Call-in "ask" line using the finance tools, with the option to ask for a character by name
- Emergency outbound call from `call_requests`, with a text fallback
- Optional monthly recap call (`monthly_recap`)
- Post-call webhook: saves the summary to `calls` and writes a recap row to the outbox
- The caller allowlist is a demo convenience, not security. The real safety rule is that the AI can't move money.
- Setup notes and the runbook go in `docs/voice.md`
