import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import pg from "pg";
import { loadChat, loadFacts, loadOutboxStats, loadProposals, maskPhone, type Db } from "./state.js";
import { loadSim, runControl, type ControlDeps } from "./control.js";
import { buildHuddle, decide, parseDecision, signLink, verifyLink } from "./huddle.js";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const env = {
  port: Number(process.env.DASHBOARD_PORT || 3001),
  financeUrl: process.env.FINANCE_URL || "http://localhost:4000",
  secret: process.env.HUDDLR_SECRET || "",
  databaseUrl: process.env.DATABASE_URL || "",
  demoPhone: process.env.DEMO_USER_PHONE || "",
  password: process.env.DASHBOARD_PASSWORD || "",
  fixture: process.env.DASHBOARD_FIXTURE === "1",
  agentsUrl: process.env.AGENTS_URL || `http://localhost:${process.env.AGENTS_PORT || 5000}`,
  timezone: process.env.DEMO_TIMEZONE || "America/Chicago",
  publicUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
};
const control: ControlDeps = { financeUrl: env.financeUrl, agentsUrl: env.agentsUrl, secret: env.secret, timezone: env.timezone };

const db: Db | undefined = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 3 }) : undefined;
const page = () => readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const huddlePage = () => readFileSync(fileURLToPath(new URL("../public/huddle.html", import.meta.url)), "utf8");
const cast = JSON.parse(readFileSync(fileURLToPath(new URL("../../contracts/cast.json", import.meta.url)), "utf8")).characters;
const app = new Hono();

app.get("/dashboard/health", (c) => c.json({ ok: true, db: !!db, auth: !!env.password }));

// ---------- The Huddle: the user's own page, opened from a private link (no dashboard password) ----------
const linkFor = (phone: string, ttlHours = 168) => `${env.publicUrl}/me/${signLink(env.secret, phone, ttlHours * 3600)}`;
const expired = (c: any) =>
  c.html(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Link expired</title><body style="font-family:system-ui;padding:40px 20px;text-align:center"><h2>This link has expired</h2><p>Text "how am I doing?" to get a new one.</p>`, 404);

app.get("/me/:token", (c) => (verifyLink(env.secret, c.req.param("token")) ? c.html(huddlePage()) : expired(c)));

app.get("/me/:token/api", async (c) => {
  const who = verifyLink(env.secret, c.req.param("token"));
  if (!who) return c.json({ error: "expired" }, 404);
  const { facts, source } = await loadFacts(env.financeUrl, env.secret, env.fixture);
  const agent = db
    ? await db.query<{ agent_handle: string | null }>(`SELECT agent_handle FROM p3_photon_spaces WHERE user_phone = $1`, [who.phone]).catch(() => ({ rows: [] }))
    : { rows: [] };
  return c.json({ huddle: buildHuddle(facts, cast), source, agentHandle: agent.rows[0]?.agent_handle ?? null });
});

app.post("/me/:token/api/decide", async (c) => {
  if (!verifyLink(env.secret, c.req.param("token"))) return c.json({ error: "expired" }, 404);
  const d = parseDecision(await c.req.json().catch(() => null));
  if (!d) return c.json({ error: "bad decision" }, 400);
  const { facts } = await loadFacts(env.financeUrl, env.secret, env.fixture);
  const whatIf = async (scenario: unknown) => {
    if (env.fixture) throw new Error("fixture mode");
    const r = await fetch(`${env.financeUrl.replace(/\/$/, "")}/tools/what_if`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-huddlr-secret": env.secret },
      body: JSON.stringify({ scenario }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error(`what_if ${r.status}`);
    return r.json();
  };
  return c.json(await decide(facts, d, whatIf));
});

// For the agents service (P2): mint a link to send when the user asks "how am I doing?".
app.post("/me-link", async (c) => {
  if (!sameSecret(c.req.header("x-huddlr-secret"), env.secret)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const phone = typeof body.phone === "string" && body.phone ? body.phone : env.demoPhone;
  if (!phone) return c.json({ error: "phone required" }, 400);
  return c.json({ url: linkFor(phone, Number(body.ttlHours) > 0 ? Number(body.ttlHours) : 168) });
});

// The dashboard shows real phone conversations, so lock it when a password is set (user: huddlr).
if (env.password) app.use("*", basicAuth({ username: "huddlr", password: env.password }));
else console.warn("[dashboard] DASHBOARD_PASSWORD not set: dashboard is public");

app.get("/", (c) => c.html(page()));

app.get("/api/state", async (c) => {
  const [{ facts, source }, chat, outbox, proposals, sim] = await Promise.all([
    loadFacts(env.financeUrl, env.secret, env.fixture),
    db && env.demoPhone ? loadChat(db, env.demoPhone).catch(() => []) : Promise.resolve([]),
    db ? loadOutboxStats(db).catch(() => null) : Promise.resolve(null),
    db && env.demoPhone ? loadProposals(db, env.demoPhone).catch(() => []) : Promise.resolve([]),
    env.fixture ? Promise.resolve(null) : loadSim(control),
  ]);
  return c.json({ facts, source, chat, outbox, proposals, sim: sim?.sim ?? null, user: env.demoPhone ? maskPhone(env.demoPhone) : null });
});

// Behind the dashboard login: a fresh Huddle link for the demo user (for the "Open Huddle" button).
app.get("/api/huddle-link", (c) =>
  env.secret && env.demoPhone ? c.json({ url: linkFor(env.demoPhone) }) : c.json({ error: "HUDDLR_SECRET and DEMO_USER_PHONE needed" }, 400),
);

// Demo controller. Same login as the dashboard; calls finance/agents on localhost with the shared secret.
app.post("/api/control/:action", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await runControl(c.req.param("action"), body, control);
  console.log(`[control] ${c.req.param("action")} ${JSON.stringify(body)} -> ${r.status}`);
  return c.json(r.result as object, r.status as 200);
});

serve({ fetch: app.fetch, port: env.port });
console.log(`[dashboard] on :${env.port} (db=${!!db}, fixture=${env.fixture})`);

function sameSecret(got: string | undefined, want: string): boolean {
  if (!want || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
