import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import {
  AcceptProposalRequest,
  CanIAffordRequest,
  ENDPOINTS,
  EventsQuery,
  FinanceEvent,
  GetPlanRequest,
  TOOL_AUTH_HEADER,
  WhatIfRequest,
} from "../../contracts/src";
import { FIXTURES } from "./data/fixtures";
import { canIAfford } from "./engine/afford";
import { planV0 } from "./engine/plan";
import { whatIf } from "./engine/whatif";
import type { ScenarioName } from "./env";
import { StubState } from "./state";

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

/**
 * The finance service as a stub: the contract endpoints answer from the fixtures (can_i_afford, purchase_now
 * and plan v0 are real logic over them). Replaced piece by piece by the real engine behind the same URLs.
 * /admin/* is for testing the stub and is not routed publicly by Caddy.
 */
export function createApp(opts: { secret: string; state: StubState }) {
  const { secret, state } = opts;
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.header("x-huddlr-data", "fixture");
    await next();
  });

  app.get(ENDPOINTS.health.path, (c) => c.json({ ok: true, service: "finance", mode: "stub", scenario: state.scenario }));

  // Everything below needs the shared secret (skipped only when none is configured, for local dev).
  app.use("*", async (c, next) => {
    if (secret && !sameSecret(c.req.header(TOOL_AUTH_HEADER), secret)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get(ENDPOINTS.facts.path, (c) => {
    const q = c.req.query("scenario");
    return c.json(state.facts(isScenario(q) ? q : undefined));
  });

  app.get(ENDPOINTS.events.path, (c) => {
    const limit = c.req.query("limit");
    const parsed = EventsQuery.safeParse({ after: c.req.query("after"), limit: limit ? Number(limit) : undefined });
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    return c.json({ events: state.listEvents(parsed.data.after, parsed.data.limit) });
  });

  const tools = ENDPOINTS.tools;

  app.post(tools.get_snapshot.path, (c) => c.json(state.facts()));

  app.post(tools.can_i_afford.path, async (c) => {
    const body = await parseBody(c, CanIAffordRequest);
    if ("response" in body) return body.response;
    return c.json(canIAfford(state.facts(), body.data.amount));
  });

  app.post(tools.what_if.path, async (c) => {
    const body = await parseBody(c, WhatIfRequest);
    if ("response" in body) return body.response;
    return c.json(whatIf(state.facts(), body.data.scenario, FIXTURES.whatIf));
  });

  app.post(tools.get_plan.path, async (c) => {
    const body = await parseBody(c, GetPlanRequest);
    if ("response" in body) return body.response;
    return c.json(planV0(state.facts(), body.data.amount));
  });

  app.post(tools.get_pending_proposal.path, (c) => c.json({ proposal: state.pending() }));

  app.post(tools.accept_proposal.path, async (c) => {
    const body = await parseBody(c, AcceptProposalRequest);
    if ("response" in body) return body.response;
    return c.json(state.accept(body.data.proposalId));
  });

  // Stub-only controls so teammates can exercise their code paths.
  app.get("/admin/scenario", (c) => c.json({ scenario: state.scenario }));
  app.post("/admin/scenario", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scenario?: unknown };
    if (!isScenario(body.scenario)) return c.json({ error: "scenario must be normal or shortfall" }, 400);
    state.reset(body.scenario);
    return c.json({ scenario: state.scenario });
  });
  app.post("/admin/events", async (c) => {
    const parsed = FinanceEvent.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    return c.json({ added: state.addEvent(parsed.data) });
  });
  app.post("/admin/reset", (c) => {
    state.reset(state.scenario);
    return c.json({ reset: true, scenario: state.scenario });
  });

  return app;
}
