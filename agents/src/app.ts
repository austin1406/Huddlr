// Agents service HTTP API. Caddy sends /agents/* here (port 5000).
// Everything except /agents/health needs the x-huddlr-secret header (skipped only when no secret is set, for local dev).
import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import {
  AGENT_ENDPOINTS,
  AGENTS_BASE_PATH,
  CompleteRequest,
  CreateProposalInput,
  DecideRequest,
  TOOL_AUTH_HEADER,
  type ProposalResult,
} from "../../contracts/src";
import type { Queryable } from "./db";
import { queueOutbox } from "./outbox";
import { geminiQuota } from "./quota";
import type { makeProposalService } from "./proposals";

type Service = ReturnType<typeof makeProposalService>;

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Parsable<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

async function body<T>(c: Context, schema: Parsable<T>): Promise<{ data: T } | { response: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  return parsed.success ? { data: parsed.data } : { response: c.json({ error: "invalid_request", issues: parsed.error.issues }, 400) };
}

/** 404 for unknown ids; 409 for wrong state (duplicate YES, expired); 200 otherwise. Body is always a ProposalResult. */
const reply = (c: Context, r: ProposalResult) => c.json(r, r.ok ? 200 : r.reason === "not_found" ? 404 : 409);

/** Tables P2 owns, cleared by reset-agents. sim_state (P1) and calls/call_requests rows from P4 are P2 tables too. */
const P2_TABLES = ["agent_state", "follow_ups", "agent_event_reactions", "memory_messages", "memory_facts", "calls", "call_requests", "outbox", "inbound_messages", "proposals"];

export function createApp(opts: { db: Queryable; proposals: Service; secret: string; demoUserPhone: string; now?: () => Promise<Date> | Date }) {
  const { db, proposals, secret, demoUserPhone } = opts;
  const now = async () => (opts.now ? await opts.now() : new Date());
  const app = new Hono().basePath(AGENTS_BASE_PATH);
  const p = AGENT_ENDPOINTS;
  const idOf = (c: Context) => Number(c.req.param("id"));

  app.get(p.health.path, async (c) => {
    const dbOk = await db.query("SELECT 1").then(() => true, () => false);
    // Gemini being rate-limited is not a health failure (templates keep working), so it doesn't change the status code.
    return c.json({ ok: dbOk, service: "agents", gemini: geminiQuota.status() }, dbOk ? 200 : 503);
  });

  app.use("*", async (c, next) => {
    if (secret && !sameSecret(c.req.header(TOOL_AUTH_HEADER), secret)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get(p.getPending.path, async (c) => {
    const phone = c.req.query("userPhone") || demoUserPhone;
    if (!phone) return c.json({ error: "userPhone required (or set DEMO_USER_PHONE)" }, 400);
    return c.json({ proposal: await proposals.getPending(phone) });
  });

  app.post(p.create.path, async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = CreateProposalInput.safeParse({ userPhone: demoUserPhone, ...raw });
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    return c.json(await proposals.create(parsed.data), 201);
  });

  app.post(p.accept.path, async (c) => {
    const b = await body(c, DecideRequest);
    return "response" in b ? b.response : reply(c, await proposals.accept(idOf(c), b.data.via));
  });

  app.post(p.decline.path, async (c) => {
    const b = await body(c, DecideRequest);
    return "response" in b ? b.response : reply(c, await proposals.decline(idOf(c), b.data.via));
  });

  app.post(p.expire.path, async (c) => reply(c, await proposals.expire(idOf(c))));

  app.post(p.complete.path, async (c) => {
    const b = await body(c, CompleteRequest);
    if ("response" in b) return b.response;
    const r = await proposals.markCompleted(idOf(c), b.data.txnId);
    // The transfer really happened: the Coach closes the loop once (idempotent on the proposal id).
    const row = r.ok ? await proposals.get(idOf(c)) : null;
    if (row)
      await queueOutbox(db, {
        idempotency_key: `proposal:${row.id}:completed`, user_phone: row.user_phone, speaker: "coach",
        text: `Saw it: ${row.action_text.replace(/^Move/, "you moved")}. Nice, you're covered.`,
        thread_key: `proposal:${row.id}`, proposal_id: row.id, priority: 1, created_sim_at: (await now()).toISOString(),
      });
    return reply(c, r);
  });

  app.post(p.reset.path, async (c) => {
    await db.query(`TRUNCATE ${P2_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    return c.json({ reset: true, tables: P2_TABLES });
  });

  return app;
}
