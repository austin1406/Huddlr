import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Webhook } from "standardwebhooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { env } from "./env.js";
import { connect, migrate, type Db } from "./db.js";
import { markDelivered, saveInbound } from "./inbound.js";
import { attachmentIds, findMessage, isFromHuman } from "./message.js";
import { sendText, setTyping } from "./photon.js";
import { runSender } from "./sender.js";
import { getAttachment, storeInboundAttachments } from "./attachments.js";
import { timingSafeEqual } from "node:crypto";

mkdirSync("data", { recursive: true });
const app = new Hono();
let verifier: Webhook | undefined;
let db: Db | undefined;

if (env.databaseUrl) {
  db = connect(env.databaseUrl);
  await migrate(db);
  console.log("[db] connected, tables ready");
  if (env.sender) {
    void runSender(db, { sendText, setTyping });
    console.log("[sender] draining outbox");
  }
} else {
  console.warn("[db] DATABASE_URL not set: inbound messages are only logged, sender is off");
}

app.get("/photon/health", async (c) => {
  let dbOk = false;
  try {
    if (db) await db.query("SELECT 1"), (dbOk = true);
  } catch {}
  return c.json({ ok: true, db: dbOk, sender: !!db && env.sender, echo: env.echo });
});

app.post("/photon/webhook", async (c) => {
  const raw = await c.req.text(); // untouched body: required for the signature check
  const headers = {
    "webhook-id": c.req.header("webhook-id") ?? "",
    "webhook-timestamp": c.req.header("webhook-timestamp") ?? "",
    "webhook-signature": c.req.header("webhook-signature") ?? "",
  };

  let event: any;
  try {
    verifier ??= new Webhook(env.webhookSecret());
    event = verifier.verify(raw, headers);
  } catch (err) {
    console.warn("[webhook] rejected:", (err as Error).message);
    return c.body(null, 400);
  }

  appendFileSync("data/events.jsonl", JSON.stringify({ receivedAt: new Date().toISOString(), id: headers["webhook-id"], event }) + "\n");

  const msg = findMessage(event);
  if (event?.type === "message.received" && msg && isFromHuman(msg)) {
    console.log("[inbound]", msg.sentBy?.handle, "→", msg.content?.text ?? msg.content?.type, attachmentIds(msg));
    if (db) {
      try {
        const id = await saveInbound(db, msg); // duplicate deliveries return null and are ignored
        if (id) console.log("[inbound] saved row", id);
        const ids = attachmentIds(msg);
        if (id && ids.length) {
          const d = db;
          void storeInboundAttachments(d, id, ids)
            .then((paths) => console.log("[inbound] stored", paths.join(", ")))
            .catch((err) => console.error("[inbound] attachment download failed:", (err as Error).message));
        }
      } catch (err) {
        console.error("[inbound] DB save failed, asking Photon to retry:", (err as Error).message);
        return c.body(null, 503);
      }
    }
    if (env.echo) void echoReply(msg);
  } else if (event?.type === "message.delivered" && msg && db) {
    await markDelivered(db, msg.id).catch(() => {});
  }
  return c.body(null, 204);
});

/** P2 reads photo bytes here (agents/src/photo.ts httpImageFetcher). Needs the shared secret. */
app.get("/photon/attachments/:id", async (c) => {
  if (!sameSecret(c.req.header("x-huddlr-secret"), env.secret)) return c.json({ error: "unauthorized" }, 401);
  try {
    const a = await getAttachment(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    return c.body(new Uint8Array(a.bytes).buffer as ArrayBuffer, 200, { "content-type": a.mime, "cache-control": "private, max-age=3600" });
  } catch (err) {
    console.error("[attachments] fetch failed:", (err as Error).message);
    return c.json({ error: "not available" }, 502);
  }
});

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!expected) return false; // never serve user photos without a configured secret
  const a = Buffer.from(given ?? ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function echoReply(msg: NonNullable<ReturnType<typeof findMessage>>) {
  const target = { spaceId: msg.space.id, senderId: msg.receivedBy!.id! };
  try {
    const got = attachmentIds(msg).length ? "your photo" : `"${msg.content?.text ?? "?"}"`;
    await sendText(target, `🧭 Coach: got ${got}.`, `echo:${msg.id}`, msg.id);
  } catch (err) {
    console.error("[echo] send failed:", err);
  }
}

serve({ fetch: app.fetch, port: env.port });
console.log(`photon service on :${env.port} (echo=${env.echo})`);
