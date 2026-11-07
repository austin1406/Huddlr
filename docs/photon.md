# Photon 2.0 notes (P3)

Verified live on 2026-11-07 against the Huddlr project (Photon 2.0 Beta, webhook API version `2026-07-01`).

## Setup we did

1. Account at photon.codes/beta → project `huddlr` → Project ID `pho_prj_01m6w35bhzeh78gce6g31k8nae` (not secret).
2. API key (`pho_sk_...`, 90 days) with project read/write and platforms write. Lives only in the server `.env`.
3. iMessage → **Add someone to the line** → a phone number → **Assign a number from the shared pool**. Each seated phone gets its own agent number.
4. Webhooks → destination `https://144-202-69-37.sslip.io/photon/webhook`, all events, signing secret `whsec_...` in `.env`.

Server env (`/opt/huddlr/photon/.env`): `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_WEBHOOK_SECRET`, `PHOTON_ECHO` (1 = spike auto-reply).

## Event shape (webhook body)

Every delivery is a public event; the message is at **`data.object`**. Dedupe by the top-level `id` (same as the `webhook-id` header).

```json
{
  "id": "pho_evt_...",
  "apiVersion": "2026-07-01",
  "type": "message.received",
  "source": "imessage.photon",
  "timestamp": "2026-11-07T23:02:30.024Z",
  "data": {
    "object": {
      "id": "pho_msg_...",
      "platform": "imessage",
      "projectId": "pho_prj_...",
      "content": { "type": "text", "format": "plain", "text": "ping" },
      "sentBy":     { "id": "pho_usr_...", "kind": "human", "handle": "+1XXXXXXXXXX" },
      "receivedBy": { "id": "pho_usr_...", "kind": "agent", "handle": "+1XXXXXXXXXX", "details": { "type": "shared" } },
      "space": { "id": "...", "kind": "direct" },
      "metadata": { "transport": "imessage" }
    }
  }
}
```

An inbound **photo** has `content: { "type": "attachment", "attachmentId": "pho_att_..." }` (no text). Download it with `downloadAttachment(attachmentId)` in `photon/src/photon.ts`.

### Event types we saw

| Type | Meaning | Who cares |
|---|---|---|
| `message.received` | A human sent the agent something | photon → inbound row for P2 |
| `message.accepted` | Photon accepted something we sent (also our typing updates) | sender (optional) |
| `message.delivered` | Our message reached the phone; has `addressedTo` and `parentMessageId` | sender: mark outbox row delivered |
| `call.*` (6 types) | Voice calls | P4 |

Only `message.received` with `sentBy.kind === "human"` should reach the agents. Our own sends come back as `accepted`/`delivered` events: never treat those as user input.

## Sending

Reply using IDs from **that person's own** inbound message:

- `spaceId` = `data.object.space.id`
- `senderId` = `data.object.receivedBy.id` (the agent's user id, not the human's)
- optional `parentMessageId` = inbound `id` → shows as a threaded reply
- `idempotency-key` header: stable per logical message (outbox row id), so retries never double-send

## What works (tested on a real iPhone)

| Feature | Result |
|---|---|
| Text in → webhook | ✅ ~1 s |
| Text reply out | ✅ delivered, threaded under the user's message |
| Typing indicator (`setSpaceTyping`) | ✅ accepted and shown |
| Photo in | ✅ arrives as `attachment` content with an attachment id |
| Image out (upload → attachment) | ⏳ testing |
| Tapbacks, polls, effects, voice notes | ❌ not on Beta iMessage (docs) |
| Group chats | ❌ shared lines are direct-only |

## Rules

- **User must text first.** A shared line can't start a conversation.
- **Every phone needs a seat** (dashboard: iMessage → Add someone to the line). Free plan: 25. Each seat may get a *different* agent number, so never hardcode the agent number.
- Webhook: verify the **raw** body (Standard Webhooks), return 2xx fast, retries on 404/408/429/5xx, no redirects followed. Server clock must be within 5 minutes.
- Use Beta docs only (`photon.codes/docs/beta/...`); Stable docs describe a different API.

## Handy commands (server)

```bash
pm2 logs photon                       # live log
pm2 restart photon --update-env       # after editing .env
tail -n 5 /opt/huddlr/photon/data/events.jsonl   # raw events
/opt/huddlr/photon/deploy/deploy.sh   # pull main + restart
```
