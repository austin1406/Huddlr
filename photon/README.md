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

## Planned

- Webhook writes inbound rows to the DB (H3-4)
- Outbox sender: one at a time, 1-3 s gaps, retries, idempotent by outbox id (H4-5)
- Indicator card PNG renderer (H6-7), seat tool (H8-9)
- Findings in `docs/photon.md`
