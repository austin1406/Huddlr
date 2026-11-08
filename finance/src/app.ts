import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AcceptProposalRequest,
  CanIAffordRequest,
  ENDPOINTS,
  ProjectionRequest,
  EventsQuery,
  FinanceEvent,
  GetPlanRequest,
  TOOL_AUTH_HEADER,
  WhatIfRequest,
} from "../../contracts/src";
import type { Backend, EngineOps } from "./backend";
import type { ScenarioName } from "./env";
import { StubBackend } from "./stub/backend";
import type { StubState } from "./stub/state";

interface Parsable<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function parseBody<T>(c: Context, schema: Parsable<T>): Promise<{ data: T } | { response: Response }> {
  const raw = await c.req.json().catch(() => ({}));
  const result = schema.safeParse(raw);
  if (result.success) return { data: result.data };
  return { response: c.json({ error: "invalid_request", issues: result.error.issues }, 400) };
}

const isScenario = (v: unknown): v is ScenarioName => v === "normal" || v === "shortfall";

const ACCOUNT_IDS = ["checking", "savings", "card", "car_loan", "ira"] as const;
const dollars = z.number().positive().finite();
const AdminBodies = {
  jump: z.object({ days: z.number().positive().max(400) }),
  demoMode: z.object({ on: z.boolean() }),
  purchase: z.object({
    amount: dollars,
    merchant: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    account: z.enum(["checking", "card"]).optional(),
  }),
  transfer: z
    .object({ from: z.enum(ACCOUNT_IDS), to: z.enum(ACCOUNT_IDS), amount: dollars })
    .refine((v) => v.from !== v.to, "from and to must differ"),
  paycheck: z.object({ amount: dollars.optional() }),
  planVersion: z.object({ version: z.enum(["v0", "v1"]) }),
  bill: z.object({
    label: z.string().min(1),
    amount: dollars,
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dueInDays: z.number().int().min(0).max(30).optional(),
    essential: z.boolean().optional(),
  }),
};

/**
 * The finance service. The contract endpoints (/health, /facts, /events, /tools/*) answer from the backend:
 * the real engine, or the fixture stub when FINANCE_MODE=stub. /admin/* controls the simulated world and is
 * not routed publicly by Caddy; the demo controller and CLI scripts call it on localhost.
 *
 * `state` (a StubState) is the original signature, kept because the agents service tests build the stub with it:
 * createApp({ secret, state }) is the same as createApp({ secret, backend: new StubBackend(state) }).
 */
export function createApp(opts: { secret: string } & ({ backend: Backend; state?: never } | { state: StubState; backend?: never })) {
  const { secret } = opts;
  const backend: Backend = opts.backend ?? new StubBackend(opts.state);
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.header("x-huddlr-data", backend.mode === "stub" ? "fixture" : "engine");
    await next();
  });

  app.get(ENDPOINTS.health.path, async (c) => c.json(await backend.health()));

  // Everything below needs the shared secret (skipped only when none is configured, for local dev).
  app.use("*", async (c, next) => {
    if (secret && !sameSecret(c.req.header(TOOL_AUTH_HEADER), secret)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get(ENDPOINTS.facts.path, async (c) => {
    const q = c.req.query("scenario");
    return c.json(await backend.facts(isScenario(q) ? q : undefined));
  });

  app.get(ENDPOINTS.events.path, async (c) => {
    const limit = c.req.query("limit");
    const parsed = EventsQuery.safeParse({ after: c.req.query("after"), limit: limit ? Number(limit) : undefined });
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    return c.json({ events: await backend.listEvents(parsed.data.after, parsed.data.limit) });
  });

  const tools = ENDPOINTS.tools;

  app.post(tools.get_snapshot.path, async (c) => c.json(await backend.facts()));

  app.post(tools.can_i_afford.path, async (c) => {
    const body = await parseBody(c, CanIAffordRequest);
    if ("response" in body) return body.response;
    return c.json(await backend.canIAfford(body.data.amount));
  });

  app.post(tools.what_if.path, async (c) => {
    const body = await parseBody(c, WhatIfRequest);
    if ("response" in body) return body.response;
    return c.json(await backend.whatIf(body.data.scenario));
  });

  app.post(tools.get_plan.path, async (c) => {
    const body = await parseBody(c, GetPlanRequest);
    if ("response" in body) return body.response;
    return c.json(await backend.plan(body.data.amount));
  });

  app.post(ENDPOINTS.project.path, async (c) => {
    if (!backend.project) return c.json({ error: "engine_only", message: "Projection needs the engine (not FINANCE_MODE=stub)." }, 501);
    const body = await parseBody(c, ProjectionRequest);
    if ("response" in body) return body.response;
    return c.json(await backend.project(body.data));
  });

  app.post(tools.get_pending_proposal.path, async (c) => c.json({ proposal: await backend.pending() }));

  app.post(tools.accept_proposal.path, async (c) => {
    const body = await parseBody(c, AcceptProposalRequest);
    if ("response" in body) return body.response;
    return c.json(await backend.accept(body.data.proposalId, body.data.via));
  });

  // ---- /admin: controls for the simulated world (not routed by Caddy)

  app.get("/admin/scenario", (c) => c.json({ scenario: backend.scenario(), mode: backend.mode }));
  app.post("/admin/scenario", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scenario?: unknown };
    if (!isScenario(body.scenario)) return c.json({ error: "scenario must be normal or shortfall" }, 400);
    await backend.setScenario(body.scenario);
    return c.json({ scenario: backend.scenario() });
  });
  app.post("/admin/events", async (c) => {
    const parsed = FinanceEvent.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    return c.json({ added: await backend.addEvent(parsed.data) });
  });
  app.post("/admin/reset", async (c) => {
    await backend.reset();
    return c.json({ reset: true, mode: backend.mode, scenario: backend.scenario() });
  });

  const engineOnly = (handler: (c: Context, engine: EngineOps) => Promise<Response>) => async (c: Context) => {
    if (!backend.engine) return c.json({ error: "engine_only", message: "Start the service without FINANCE_MODE=stub to use this." }, 501);
    return handler(c, backend.engine);
  };

  app.get("/admin/state", engineOnly(async (c, e) => c.json(await e.state())));

  app.post("/admin/sim/jump-days", engineOnly(async (c, e) => {
    const body = await parseBody(c, AdminBodies.jump);
    if ("response" in body) return body.response;
    return c.json({ sim: await e.jumpDays(body.data.days), state: await e.state() });
  }));

  app.post("/admin/sim/demo-mode", engineOnly(async (c, e) => {
    const body = await parseBody(c, AdminBodies.demoMode);
    if ("response" in body) return body.response;
    return c.json({ sim: await e.setDemoMode(body.data.on) });
  }));

  app.post("/admin/plan-version", engineOnly(async (c, e) => {
    const body = await parseBody(c, AdminBodies.planVersion);
    if ("response" in body) return body.response;
    return c.json({ planVersion: e.setPlanVersion(body.data.version) });
  }));

  app.post("/admin/purchase", engineOnly(async (c, e) => {
    const body = await parseBody(c, AdminBodies.purchase);
    if ("response" in body) return body.response;
    return c.json({ txn: await e.purchase(body.data) });
  }));

  app.post("/admin/transfer", engineOnly(async (c, e) => {
    const body = await parseBody(c, AdminBodies.transfer);
    if ("response" in body) return body.response;
    return c.json({ txn: await e.transfer(body.data.from, body.data.to, body.data.amount) });
  }));

  app.post("/admin/paycheck", engineOnly(async (c, e) => {
    const body = await parseBody(c, AdminBodies.paycheck);
    if ("response" in body) return body.response;
    return c.json({ txn: await e.paycheck(body.data.amount) });
  }));

  app.post("/admin/bill", engineOnly(async (c, e) => {
    const body = await parseBody(c, AdminBodies.bill);
    if ("response" in body) return body.response;
    return c.json({ bill: await e.bill(body.data) });
  }));

  return app;
}
