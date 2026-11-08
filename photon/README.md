# photon/

iMessage text and images through Photon 2.0 (Beta docs only: `photon.codes/docs/beta/...`).

Owner: Shreya Balaji (@shreyaBalaji1), P3

## Quick start (local)

```bash
cd photon
npm install
cp ../.env.example .env   # then fill PHOTON_API_KEY, PHOTON_PROJECT_ID, PHOTON_WEBHOOK_SECRET
npm run dev               # http://localhost:3000/photon/health
```

`PHOTON_ECHO=1` makes the service reply to every inbound text (spike only; turn off once the outbox exists).

## Server (Vultr VM, Ubuntu 24.04)

One command as root on a fresh VM (domain optional; defaults to `<ip>.sslip.io`):

```bash
curl -fsSL https://raw.githubusercontent.com/austin1406/Huddlr/main/photon/deploy/setup-vm.sh | bash -s -- [your-domain]
```

It installs Node 22, pm2, Caddy (HTTPS), the firewall, clones the repo to `/opt/huddlr`, routes paths to each service (`deploy/Caddyfile`), and starts this service.
Update later with `/opt/huddlr/photon/deploy/deploy.sh`.

| Path | Service | Port |
|---|---|---|
| `/photon/*` | photon (P3) | 3000 |
| `/facts*`, `/tools/*` | finance (P1) | 4000 |
| `/agents/*` | agents (P2) | 5000 |
| `/voice/*` | voice (P4) | 6000 |
| everything else | dashboard (P3) | 3001 |

## Files

- `src/server.ts`: `/photon/health`, `/photon/webhook` (Standard Webhooks signature check, duplicate protection by `webhook-id`, logs every event to `data/events.jsonl`)
- `src/photon.ts`: `sendText`, `sendImage` (upload, then attachment), `setTyping`, `downloadAttachment`
- `src/message.ts`: finds the message inside an event; `isFromHuman` so we never answer ourselves
- `src/sendTest.ts`: `npx tsx src/sendTest.ts <spaceId> <agentUserId> [image.png]`

## Rules learned from the docs

- The user must text first; a shared line can't start a conversation.
- Each seated phone may get a different agent number. Always reply with the `space.id` and `receivedBy.id` from that person's own message.
- Shared lines support direct chats only (no groups).
- Webhooks: verify the raw body, return 2xx fast, dedupe by `webhook-id`; Photon retries on 404/408/429/5xx.

## How messages flow

- **In:** Photon webhook → signature check → `inbound_messages` row (duplicate deliveries ignored via `provider_msg_id`). If the DB write fails we return 503 so Photon retries. P2's agents poll that table.
- **Out:** agents write `outbox` rows. The sender claims one at a time (priority, then oldest), shows typing, waits 1-3 s (0.3-0.8 s in demo mode), sends `<emoji> <Name>: <text>`, threads under `reply_to`, marks `sent`. Failures retry with backoff; after 3 attempts the row is `failed` with `last_error`.
- **Held:** Photon can't text someone first. If a phone hasn't texted the line yet, its rows go to `held` and are released the moment that person texts.
- `p3_photon_spaces` remembers each phone's Photon conversation (`space_id`, our agent's user id) from their first text. `p3_outbox_sends` records Photon's message id and delivery time.

Settings: `DATABASE_URL` (shared `/opt/huddlr/.env`), `PHOTON_SENDER=0` pauses the sender, `PHOTON_ECHO=1` is the old spike auto-reply (keep it off with agents running). `GET /photon/health` shows `db` and `sender`.

`npm test` runs the whole flow against an in-memory Postgres.

## Planned

- Indicator card PNG renderer for `attachment: indicator_card` (H6-7); until then those rows send text only
- ~~Store inbound photos~~ done: saved to `data/attachments/`, paths in `inbound_messages.attachment_paths`, bytes at `GET /photon/attachments/:id` (needs `x-huddlr-secret`)
- Seat tool (H8-9)
