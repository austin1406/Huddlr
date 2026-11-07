// Starts the agents service: migrates P2's tables, serves /agents/* on AGENTS_PORT (5000),
// and polls inbound_messages for user replies.
//   npm start            (needs DATABASE_URL; HUDDLR_SECRET and DEMO_USER_PHONE from the shared .env)
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { handleChat } from "./chat";
import { migrate, pool, readClock } from "./db";
import { maybeSendDigest, pollEvents, type DebateDeps } from "./debate";
import { financeClient } from "./finance";
import { makeProposalService } from "./proposals";
import { handleInbound } from "./replies";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const env = {
  port: Number(process.env.AGENTS_PORT || 5000),
  databaseUrl: process.env.DATABASE_URL || "",
  secret: process.env.HUDDLR_SECRET || "",
  demoUserPhone: process.env.DEMO_USER_PHONE || "",
  /** Real-clock polling interval (delivery mechanics, not calendar logic). */
  pollMs: Number(process.env.AGENTS_POLL_MS || 1000),
  /** P1's finance service. On the VM it is localhost:4000; FINANCE_URL overrides. */
  financeUrl: process.env.FINANCE_URL || `http://localhost:${process.env.FINANCE_PORT || 4000}`,
  eventsPollMs: Number(process.env.AGENTS_EVENTS_POLL_MS || 5000),
};

if (!env.databaseUrl) {
  console.error("[agents] DATABASE_URL is not set. Ask P3 for it, or point it at a local Postgres.");
  process.exit(1);
}
if (!env.secret) console.warn("[agents] HUDDLR_SECRET is empty: endpoints are open (local dev only).");

const db = pool(env.databaseUrl);
await migrate(db);
const now = async () => (await readClock(db)).now;
const proposals = makeProposalService(db, now);
const finance = financeClient(env.financeUrl, env.secret);
const debate: DebateDeps = { db, finance, proposals, userPhone: env.demoUserPhone, clock: () => readClock(db) };

serve({ fetch: createApp({ db, proposals, secret: env.secret, demoUserPhone: env.demoUserPhone }).fetch, port: env.port }, (info) =>
  console.log(`[agents] listening on :${info.port}/agents`),
);

// Inbound replies. One at a time, oldest first; handleInbound claims each row so a second worker can't double-handle it.
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const r = await db.query<{ id: number; user_phone: string; text: string | null }>(
      "SELECT id, user_phone, text FROM inbound_messages WHERE processed_at IS NULL ORDER BY id LIMIT 20",
    );
    for (const row of r.rows) {
      const at = await now();
      const result = await handleInbound(db, proposals, { ...row, id: Number(row.id) }, at);
      if (result.kind === "chat") {
        const chat = await handleChat({ db, facts: () => finance.facts(), userPhone: row.user_phone }, { id: Number(row.id), text: row.text }, at);
        console.log(`[agents] inbound ${row.id}: chat -> ${chat.responder}${chat.learned ? ` (saved ${chat.learned} to memory)` : ""}`);
      } else if (result.kind !== "duplicate") console.log(`[agents] inbound ${row.id}: ${result.kind}`);
    }
    await proposals.expireStale();
  } catch (e) {
    console.error("[agents] poll failed:", (e as Error).message);
  } finally {
    busy = false;
  }
}, env.pollMs).unref?.();

// Finance events -> debates. Sequential so two debates never interleave in the chat.
if (!env.demoUserPhone) console.warn("[agents] DEMO_USER_PHONE is empty: event reactions are off.");
let eventsBusy = false;
setInterval(async () => {
  if (eventsBusy || !env.demoUserPhone) return;
  eventsBusy = true;
  try {
    for (const r of await pollEvents(debate))
      console.log(`[agents] event ${r.eventId}: ${r.decision} (${r.reason})${r.firstMessageMs != null ? ` first=${r.firstMessageMs}ms plan=${r.planMs}ms` : ""}`);
    const facts = await finance.facts();
    if (await maybeSendDigest(debate, facts.timezone)) console.log("[agents] queued the evening digest");
  } catch (e) {
    console.error("[agents] events poll failed:", (e as Error).message);
  } finally {
    eventsBusy = false;
  }
}, env.eventsPollMs);
