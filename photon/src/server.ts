import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Webhook } from "standardwebhooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { env } from "./env.js";
import { attachmentIds, findMessage, isFromHuman } from "./message.js";
import { sendText, setTyping } from "./photon.js";

mkdirSync("data", { recursive: true });
const app = new Hono();
const seen = new Set<string>(); // spike: in-memory duplicate protection (moves to the DB at H3-4)
let verifier: Webhook | undefined;

app.get("/photon/health", (c) => c.json({ ok: true, echo: env.echo }));

app.post("/photon/webhook", async (c) => {
  const raw = await c.req.text(); // untouched body: required for the signature check
  const headers = {
    "webhook-id": c.req.header("webhook-id") ?? "",
    "webhook-timestamp": c.req.header("webhook-timestamp") ?? "",
    "webhook-signature": c.req.header("webhook-signature") ?? "",
  };

  let event: unknown;
  try {
    verifier ??= new Webhook(env.webhookSecret());
    event = verifier.verify(raw, headers);
  } catch (err) {
    console.warn("[webhook] rejected:", (err as Error).message);
    return c.body(null, 400);
  }

  const id = headers["webhook-id"];
  if (seen.has(id)) return c.body(null, 204);
  seen.add(id);

  // Spike: record every event so we learn Photon's real payload shape.
  appendFileSync("data/events.jsonl", JSON.stringify({ receivedAt: new Date().toISOString(), id, event }) + "\n");
  console.log("[webhook] event", id, JSON.stringify(event).slice(0, 500));

  const msg = findMessage(event);
  if (msg && isFromHuman(msg)) {
    console.log("[inbound]", msg.sentBy?.handle, "→", msg.content?.text ?? msg.content?.type, attachmentIds(msg));
    if (env.echo) void echoReply(msg); // don't make Photon wait on our reply
  }
  return c.body(null, 204);
});

async function echoReply(msg: NonNullable<ReturnType<typeof findMessage>>) {
  const target = { spaceId: msg.space.id, senderId: msg.receivedBy!.id! };
  try {
    const typing = await setTyping(target, true);
    await new Promise((r) => setTimeout(r, 1200));
    const got = attachmentIds(msg).length ? "your photo" : `"${msg.content?.text ?? "?"}"`;
    await sendText(target, `🧭 Coach: got ${got}. Typing indicator ${typing ? "works" : "not supported"}.`, `echo:${msg.id}`, msg.id);
  } catch (err) {
    console.error("[echo] send failed:", err);
  }
}

serve({ fetch: app.fetch, port: env.port });
console.log(`photon service on :${env.port} (echo=${env.echo})`);
