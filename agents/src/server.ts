// Starts the agents service: migrates P2's tables, serves /agents/* on AGENTS_PORT (5000),
// polls inbound_messages for user texts, polls P1's /events for debates, and runs follow-ups and escalation.
//
//   npm start         production: DATABASE_URL, HUDDLR_SECRET, DEMO_USER_PHONE, GEMINI_API_KEY in the shared .env
//   npm run local     no DATABASE_URL needed: a Postgres saved under agents/.data, plus /agents/dev/* to fake texts
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { handleChat } from "./chat";
import { migrate, pool, readClock, type Queryable } from "./db";
import { maybeSendDigest, pollEvents, runOptions, runRoundtable, runWindfall, type DebateDeps } from "./debate";
import { maybeWelcome } from "./welcome";
import { huddleLinkClient, replyWithHuddleLink } from "./huddle";
import { devRoutes } from "./dev";
import { runFollowUps } from "./followups";
import { financeClient } from "./finance";
import { fileImageFetcher, geminiReader, handlePhoto, httpImageFetcher } from "./photo";
import { makeProposalService } from "./proposals";
import { handleInbound } from "./replies";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const local = process.argv.includes("--local") || process.env.AGENTS_LOCAL === "1";
const env = {
  /** 5000 on the VM (Caddy). Locally 5055, because macOS AirPlay Receiver already listens on 5000. */
  port: Number(process.env.AGENTS_PORT || (local ? 5055 : 5000)),
  databaseUrl: local ? "" : process.env.DATABASE_URL || "",
  /** Required on our endpoints in production. Always sent to P1's finance service (its stub reads the same .env). */
  secret: process.env.HUDDLR_SECRET || "",
  demoUserPhone: process.env.DEMO_USER_PHONE || "",
  /** Real-clock polling intervals (delivery mechanics, not calendar logic). */
  pollMs: Number(process.env.AGENTS_POLL_MS || 1000),
  eventsPollMs: Number(process.env.AGENTS_EVENTS_POLL_MS || (local ? 2000 : 5000)),
  /** P1's finance service. On the VM it is localhost:4000; FINANCE_URL overrides. */
  financeUrl: process.env.FINANCE_URL || `http://localhost:${process.env.FINANCE_PORT || 4000}`,
  /** P3's dashboard service, which makes Huddle links (POST /me-link). */
  dashboardUrl: process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3001}`,
};

let db: Queryable & { exec?: (sql: string) => Promise<unknown> };
if (env.databaseUrl) {
  db = pool(env.databaseUrl);
} else if (local) {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = fileURLToPath(new URL("../.data/pglite", import.meta.url));
  mkdirSync(dir, { recursive: true });
  db = new PGlite(dir);
  console.log("[agents] LOCAL mode: Postgres in agents/.data, no secret, /agents/dev/* enabled");
} else {
  console.error("[agents] DATABASE_URL is not set. Ask P3 for it, or run `npm run local` to try everything on your laptop.");
  process.exit(1);
}
if (!env.secret && !local) console.warn("[agents] HUDDLR_SECRET is empty: endpoints are open.");
if (!env.demoUserPhone) console.warn("[agents] DEMO_USER_PHONE is empty: event reactions and escalation are off.");

await migrate(db);
const clock = () => readClock(db);
const now = async () => (await clock()).now;
const proposals = makeProposalService(db, now);
const finance = financeClient(env.financeUrl, env.secret);
const debate: DebateDeps = { db, finance, proposals, userPhone: env.demoUserPhone, clock };
// Photo bytes: P3's /photon/attachments/:id in production; locally the "attachment id" is a file path (/agents/dev/photo).
const huddleLink = huddleLinkClient(env.dashboardUrl, env.secret);
const fetchImage = local ? fileImageFetcher : httpImageFetcher(process.env.PHOTON_URL || process.env.PUBLIC_BASE_URL || "http://localhost:3000", env.secret);

const app = createApp({ db, proposals, secret: local ? "" : env.secret, demoUserPhone: env.demoUserPhone, now });
if (local) devRoutes(app, { db, userPhone: env.demoUserPhone || "+15555550100", now, finance });
serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[agents] listening on :${info.port}/agents`));

/** Runs `fn` every `ms` (real clock), never overlapping itself. */
function every(ms: number, name: string, fn: () => Promise<void>) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[agents] ${name} failed:`, (e as Error).message);
    } finally {
      busy = false;
    }
  }, ms);
}

// User texts (rows P3's webhook writes). Oldest first; handleInbound claims each row so nothing is handled twice.
every(env.pollMs, "inbound", async () => {
  const r = await db.query<{ id: number; user_phone: string; text: string | null; attachment_ids: string[] | null }>(
    "SELECT id, user_phone, text, attachment_ids FROM inbound_messages WHERE processed_at IS NULL ORDER BY id LIMIT 20",
  );
  for (const row of r.rows) {
    const at = await now();
    // A phone's first text ever: the Coach introduces the crew before answering.
    const welcomed = await maybeWelcome(db, { id: Number(row.id), user_phone: row.user_phone }, at, huddleLink);
    if (welcomed) console.log(`[agents] text ${row.id}: welcomed ${row.user_phone}`);
    // A photo with no text: read the item and price, then can_i_afford.
    if (row.attachment_ids?.length && !row.text?.trim()) {
      const p = await handlePhoto(
        { db, finance, userPhone: row.user_phone, fetchImage, readPhoto: process.env.GEMINI_API_KEY ? geminiReader(process.env.GEMINI_API_KEY) : undefined },
        { id: Number(row.id), user_phone: row.user_phone, attachment_ids: row.attachment_ids },
        at,
      );
      if (p.kind !== "duplicate") console.log(`[agents] photo ${row.id}: ${p.kind}${p.amount != null ? ` ($${p.amount})` : ""}`);
      continue;
    }
    const result = await handleInbound(db, proposals, { ...row, id: Number(row.id) }, at);
    if (result.kind === "huddle_link") {
      // The welcome just carried a link; a second one would cancel it.
      const sent = welcomed ? "in welcome" : await replyWithHuddleLink(db, huddleLink, { id: Number(row.id), user_phone: row.user_phone }, at);
      console.log(`[agents] text ${row.id}: huddle link ${sent}`);
    } else if (result.kind === "chat") {
      const chat = await handleChat(
        {
          db, facts: () => finance.facts(), userPhone: row.user_phone, finance, proposals,
          windfall: (ask, t) => runWindfall({ db, finance, proposals, userPhone: row.user_phone }, ask, t),
          options: (ask, t) => runOptions({ db, finance, proposals, userPhone: row.user_phone }, ask, t),
          roundtable: (ask, t) => runRoundtable({ db, finance, proposals, userPhone: row.user_phone }, ask, t),
        },
        { id: Number(row.id), text: row.text },
        at,
      );
      console.log(`[agents] text ${row.id}: chat -> ${chat.debate ? `debate (${chat.debate.join(", ")})` : chat.responder}${chat.learned ? ` (saved ${chat.learned} to memory)` : ""}${chat.source === "template" ? ` [fallback: ${chat.why}]` : ""}`);
    } else if (result.kind !== "duplicate") console.log(`[agents] text ${row.id}: ${result.kind}`);
  }
  await proposals.expireStale();
});

// Finance events -> debates, then the evening digest, reminders, and escalation. Sequential so debates never interleave.
every(env.eventsPollMs, "events", async () => {
  if (!env.demoUserPhone) return;
  for (const r of await pollEvents(debate))
    console.log(`[agents] event ${r.eventId}: ${r.decision} (${r.reason})${r.firstMessageMs != null ? ` first=${r.firstMessageMs}ms plan=${r.planMs}ms` : ""}`);
  const facts = await finance.facts();
  if (await maybeSendDigest(debate, facts.timezone)) console.log("[agents] queued the evening digest");
  for (const f of await runFollowUps({ db, proposals, userPhone: env.demoUserPhone, now: await now(), facts }))
    console.log(`[agents] follow-up ${f.id} (${f.kind}): ${f.outcome}`);
});
