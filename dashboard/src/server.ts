import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import pg from "pg";
import { loadChat, loadFacts, loadOutboxStats, loadProposals, maskPhone, type Db } from "./state.js";
import { loadSim, runControl, type ControlDeps } from "./control.js";
import { cancelOlderLinks, checkCode, endSession, linksValidFrom, migrateAuth, newCode, newSession, queueCode, sessionPhone, SESSION_TTL_MS } from "./auth.js";
import { buildHuddle, decide, parseDecision, signLink, understand, verifyLink, type Decision } from "./huddle.js";

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
  geminiKey: process.env.GEMINI_API_KEY || "",
  huddleModel: process.env.HUDDLE_MODEL || "",
};
const control: ControlDeps = { financeUrl: env.financeUrl, agentsUrl: env.agentsUrl, secret: env.secret, timezone: env.timezone };

const db: Db | undefined = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 3 }) : undefined;
const page = () => readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const huddlePage = () => readFileSync(fileURLToPath(new URL("../public/huddle.html", import.meta.url)), "utf8");
const cast = JSON.parse(readFileSync(fileURLToPath(new URL("../../contracts/cast.json", import.meta.url)), "utf8")).characters;
const app = new Hono();

app.get("/dashboard/health", (c) => c.json({ ok: true, db: !!db, auth: !!env.password }));

// ---------- The Huddle: the user's own page. Link + a code texted to their phone (see auth.ts). ----------
const linkFor = (phone: string, ttlHours = 24) => `${env.publicUrl}/me/${signLink(env.secret, phone, ttlHours * 3600)}`;
const COOKIE = "huddle_session";
const expired = (c: any) =>
  c.html(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Link expired</title><body style="font-family:system-ui;padding:48px 20px;text-align:center;color:#132039"><h2>This link has expired</h2><p>Text “huddle link” to get a new one.</p>`, 404);

// Login data lives in Postgres. Without DATABASE_URL (local preview) an in-memory PGlite stands in and codes print to the log.
const authDb: Promise<Db> = (async () => {
  if (db) {
    await migrateAuth(db);
    return db;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const mem = new PGlite();
  await mem.exec(readFileSync(fileURLToPath(new URL("../../contracts/p2_agents.sql", import.meta.url)), "utf8"));
  await migrateAuth(mem as unknown as Db);
  return mem as unknown as Db;
})();
authDb.catch((e) => console.error("[huddle] auth store unavailable:", e.message));

/** The phone this link is for, if the link is current (not expired, not replaced by a newer one). */
async function linkPhone(token: string): Promise<string | null> {
  const who = verifyLink(env.secret, token);
  if (!who) return null;
  return who.issuedAt >= (await linksValidFrom(await authDb, who.phone)) ? who.phone : null;
}

/** Link is current AND this browser logged in with the code for that same phone. */
async function gate(c: any): Promise<{ phone: string } | Response> {
  const phone = await linkPhone(c.req.param("token"));
  if (!phone) return c.json({ error: "expired" }, 404);
  if ((await sessionPhone(await authDb, env.secret, getCookie(c, COOKIE))) !== phone) return c.json({ login: true, hint: maskPhone(phone) }, 401);
  return { phone };
}

function startSession(c: any, token: string) {
  const https = c.req.header("x-forwarded-proto") === "https" || env.publicUrl.startsWith("https");
  setCookie(c, COOKIE, token, { path: "/me", httpOnly: true, secure: https, sameSite: "Lax", maxAge: SESSION_TTL_MS / 1000 });
}

app.get("/me/:token", async (c) => ((await linkPhone(c.req.param("token"))) ? c.html(huddlePage()) : expired(c)));

app.post("/me/:token/auth/send", async (c) => {
  const phone = await linkPhone(c.req.param("token"));
  if (!phone) return c.json({ error: "expired" }, 404);
  const adb = await authDb;
  const r = await newCode(adb, env.secret, phone);
  if (!r.ok)
    return c.json(
      { error: r.reason === "wait" ? `A code was just sent. You can ask for another in ${r.retryInSeconds} seconds.` : "Too many codes this hour. Try again later.", retryInSeconds: r.retryInSeconds },
      429,
    );
  await queueCode(adb, phone, r.code);
  if (!db) console.log(`[huddle] code for ${maskPhone(phone)}: ${r.code} (no database, so it was not texted)`);
  return c.json({ ok: true, hint: maskPhone(phone), resendInSeconds: 30 });
});

app.post("/me/:token/auth/verify", async (c) => {
  const phone = await linkPhone(c.req.param("token"));
  if (!phone) return c.json({ error: "expired" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const adb = await authDb;
  const r = await checkCode(adb, env.secret, phone, String(body.code ?? ""));
  if (r === "ok") {
    startSession(c, await newSession(adb, env.secret, phone));
    return c.json({ ok: true });
  }
  const msg = {
    wrong: "That code doesn't match. Check the latest text and try again.",
    expired: "That code has expired. Send a new one.",
    too_many: "Too many wrong tries. Send a new code.",
    none: "Send a code first.",
  }[r];
  return c.json({ error: msg, reason: r }, 401);
});

app.post("/me/:token/auth/lock", async (c) => {
  await endSession(await authDb, env.secret, getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: "/me" });
  return c.json({ ok: true });
});

app.get("/me/:token/api", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { facts, source } = await loadFacts(env.financeUrl, env.secret, env.fixture);
  const agent = db
    ? await db.query<{ agent_handle: string | null }>(`SELECT agent_handle FROM p3_photon_spaces WHERE user_phone = $1`, [g.phone]).catch(() => ({ rows: [] }))
    : { rows: [] };
  return c.json({ huddle: buildHuddle(facts, cast), source, agentHandle: agent.rows[0]?.agent_handle ?? null });
});

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

app.post("/me/:token/api/decide", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const d = parseDecision(await c.req.json().catch(() => null));
  if (!d) return c.json({ error: "bad decision" }, 400);
  const { facts } = await loadFacts(env.financeUrl, env.secret, env.fixture);
  return c.json(await decide(facts, d, whatIf));
});

// Typed "what if…" questions. Gemini only decides which decision it is; the numbers come from decide().
const agentsConfig = JSON.parse(readFileSync(fileURLToPath(new URL("../../contracts/agents-config.json", import.meta.url)), "utf8"));
const askGemini = env.geminiKey
  ? async (prompt: string) => {
      const model = env.huddleModel || agentsConfig.character_model?.model || "gemini-flash-lite-latest";
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.geminiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 120, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`gemini ${r.status}`);
      const j: any = await r.json();
      return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    }
  : null;

const askLog = new Map<string, number[]>(); // token -> recent ask times, so one link can't burn the shared AI quota
function tooMany(token: string): boolean {
  const now = Date.now();
  const recent = (askLog.get(token) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  askLog.set(token, recent);
  if (askLog.size > 500) askLog.clear();
  return recent.length > 12;
}

app.post("/me/:token/api/ask", async (c) => {
  const token = c.req.param("token");
  const g = await gate(c);
  if (g instanceof Response) return g;
  if (tooMany(token)) return c.json({ error: "Too many questions at once. Try again in a minute." }, 429);
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 300) : "";
  if (!text) return c.json({ error: "Type a question first." }, 400);
  const { facts } = await loadFacts(env.financeUrl, env.secret, env.fixture);
  const { decision, by } = await understand(text, facts.localDate, askGemini);
  console.log(`[huddle] ask ${JSON.stringify(text)} -> ${JSON.stringify(decision)} (${by})`);
  if (!decision) return c.json({ understood: false, by });
  return c.json({ understood: true, by, decision: decision as Decision, result: await decide(facts, decision, whatIf) });
});

// For the agents service (P2): a fresh link for the welcome text or when the user asks for it.
// A new link cancels that phone's older links (so a forwarded one stops working).
app.post("/me-link", async (c) => {
  if (!sameSecret(c.req.header("x-huddlr-secret"), env.secret)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const phone = typeof body.phone === "string" && body.phone ? body.phone : env.demoPhone;
  if (!phone) return c.json({ error: "phone required" }, 400);
  if (body.cancelOlder !== false) await cancelOlderLinks(await authDb, phone);
  return c.json({ url: linkFor(phone, Number(body.ttlHours) > 0 ? Number(body.ttlHours) : 24) });
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

// Behind the dashboard login: open the demo user's Huddle already signed in (the team is logged in here).
// Does not cancel the phone's link, so the presenter's phone keeps working.
app.get("/api/huddle-open", async (c) => {
  if (!env.secret || !env.demoPhone) return c.text("HUDDLR_SECRET and DEMO_USER_PHONE are needed", 400);
  startSession(c, await newSession(await authDb, env.secret, env.demoPhone));
  return c.redirect(linkFor(env.demoPhone).replace(env.publicUrl, ""));
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

function sameSecret(got: string | undefined, want: string): boolean {
  if (!want || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
