# photon/

iMessage text and images through Photon 2.0 (Beta docs only).

Owner: Shreya Balaji (@shreyaBalaji1), P3

- Webhook with signature check and duplicate protection
- Outbox sender: one message at a time, 1-3 second gaps, retries, idempotent by outbox ID
- Indicator card renderer (PNG) for `attachment: indicator_card`
- Seat tool: assign a phone a seat on the shared line (25 on the free plan). The agent can only message a user who has texted the line first.
- Notes on what works and what doesn't go in `docs/photon.md`
