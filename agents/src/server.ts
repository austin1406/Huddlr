// Starts the agents service: migrates P2's tables, serves /agents/* on AGENTS_PORT (5000),
// and polls inbound_messages for user replies.
//   npm start            (needs DATABASE_URL; HUDDLR_SECRET and DEMO_USER_PHONE from the shared .env)
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { migrate, pool, readClock } from "./db";
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
      const result = await handleInbound(db, proposals, { ...row, id: Number(row.id) }, await now());
      if (result.kind !== "duplicate") console.log(`[agents] inbound ${row.id}: ${result.kind}`);
    }
    await proposals.expireStale();
  } catch (e) {
    console.error("[agents] poll failed:", (e as Error).message);
  } finally {
    busy = false;
  }
}, env.pollMs).unref?.();
