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
