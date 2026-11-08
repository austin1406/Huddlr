import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import pg from "pg";
import { loadChat, loadFacts, loadOutboxStats, loadProposals, maskPhone, type Db } from "./state.js";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const env = {
  port: Number(process.env.DASHBOARD_PORT || 3001),
  financeUrl: process.env.FINANCE_URL || "http://localhost:4000",
  secret: process.env.HUDDLR_SECRET || "",
  databaseUrl: process.env.DATABASE_URL || "",
  demoPhone: process.env.DEMO_USER_PHONE || "",
  password: process.env.DASHBOARD_PASSWORD || "",
  fixture: process.env.DASHBOARD_FIXTURE === "1",
};

const db: Db | undefined = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 3 }) : undefined;
const page = () => readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const app = new Hono();

app.get("/dashboard/health", (c) => c.json({ ok: true, db: !!db, auth: !!env.password }));

// The dashboard shows real phone conversations, so lock it when a password is set (user: huddlr).
if (env.password) app.use("*", basicAuth({ username: "huddlr", password: env.password }));
else console.warn("[dashboard] DASHBOARD_PASSWORD not set: dashboard is public");

app.get("/", (c) => c.html(page()));

app.get("/api/state", async (c) => {
  const [{ facts, source }, chat, outbox, proposals] = await Promise.all([
    loadFacts(env.financeUrl, env.secret, env.fixture),
    db && env.demoPhone ? loadChat(db, env.demoPhone).catch(() => []) : Promise.resolve([]),
    db ? loadOutboxStats(db).catch(() => null) : Promise.resolve(null),
    db && env.demoPhone ? loadProposals(db, env.demoPhone).catch(() => []) : Promise.resolve([]),
  ]);
  return c.json({ facts, source, chat, outbox, proposals, user: env.demoPhone ? maskPhone(env.demoPhone) : null });
});

serve({ fetch: app.fetch, port: env.port });
console.log(`[dashboard] on :${env.port} (db=${!!db}, fixture=${env.fixture})`);
