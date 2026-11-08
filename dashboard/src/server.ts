import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import pg from "pg";
import { loadChat, loadFacts, loadOutboxStats, loadProposals, maskPhone, type Db } from "./state.js";
import { loadSim, runControl, type ControlDeps } from "./control.js";

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
};
const control: ControlDeps = { financeUrl: env.financeUrl, agentsUrl: env.agentsUrl, secret: env.secret, timezone: env.timezone };

const db: Db | undefined = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 3 }) : undefined;
const page = () => readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const app = new Hono();

app.get("/dashboard/health", (c) => c.json({ ok: true, db: !!db, auth: !!env.password }));

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

// Demo controller. Same login as the dashboard; calls finance/agents on localhost with the shared secret.
app.post("/api/control/:action", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await runControl(c.req.param("action"), body, control);
  console.log(`[control] ${c.req.param("action")} ${JSON.stringify(body)} -> ${r.status}`);
  return c.json(r.result as object, r.status as 200);
});

serve({ fetch: app.fetch, port: env.port });
console.log(`[dashboard] on :${env.port} (db=${!!db}, fixture=${env.fixture})`);
