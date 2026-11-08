import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcceptProposalResponse,
  CanIAffordResponse,
  ENDPOINTS,
  EventsResponse,
  FactsSnapshot,
  MemorySimStateStore,
  Plan,
  TOOL_AUTH_HEADER,
  WhatIfResult,
  type ProposalSummary,
} from "../../contracts/src";
import { createApp } from "../src/app";
import { PERSONA } from "../src/data/config";
import { EngineBackend } from "../src/engine/backend";
import { NoProposals, type ProposalGateway } from "../src/proposals";
import { FileSimStateStore, PgSimStateStore, type Queryable } from "../src/sim";

const REAL_NOW = Date.parse("2026-11-07T16:00:00.000Z"); // 10:00 in Chicago
const SECRET = "s3cret";
const H = { [TOOL_AUTH_HEADER]: SECRET, "content-type": "application/json" };

async function setup(opts: { gateway?: ProposalGateway; dataFile?: string } = {}) {
  const store = new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: new Date(REAL_NOW).toISOString() });
  const backend = await EngineBackend.create({ persona: PERSONA, store, gateway: opts.gateway ?? new NoProposals(), realNow: () => REAL_NOW, dataFile: opts.dataFile });
  const app = createApp({ secret: SECRET, backend });
  const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: H, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: H });
  return { backend, store, app, post, get };
}

test("serves contract-shaped facts from the engine, marked as engine data", async () => {
  const { app, get } = await setup();
  const res = await get("/facts");
  assert.equal(res.headers.get("x-huddlr-data"), "engine");
  const facts = FactsSnapshot.parse(await res.json());
  assert.equal(facts.localDate, "2026-11-07");
  assert.equal(facts.forecast.lowest.balance, 147.5);
  assert.equal((await app.request("/facts")).status, 401);
  assert.equal((await app.request("/health")).status, 200);
});

test("tools: can_i_afford, what_if, get_plan answer from the engine", async () => {
  const { post } = await setup();
  const a = CanIAffordResponse.parse(await (await post(ENDPOINTS.tools.can_i_afford.path, { amount: 50 })).json());
  assert.equal(a.verdict, "tight");
  const w = WhatIfResult.parse(await (await post(ENDPOINTS.tools.what_if.path, { scenario: { type: "lose_income", months: 2 } })).json());
  assert.ok(w.after.firstNegativeDate);
  const p = Plan.parse(await (await post(ENDPOINTS.tools.get_plan.path, { amount: 600 })).json());
  assert.equal(p.lines[0]?.destination, "card");
});

test("a purchase turns into a big_purchase event once, and shows in recentEvents", async () => {
  const { post, get } = await setup();
  const r = await post("/admin/purchase", { amount: 142.37, merchant: "Target", category: "shopping" });
  assert.equal(r.status, 200);
  const events = EventsResponse.parse(await (await get("/events")).json()).events;
  const big = events.filter((e) => e.type === "big_purchase");
  assert.equal(big.length, 1);
  assert.deepEqual(big[0]?.data, { merchant: "Target", amount: 142.37, category: "shopping" });
  await get("/events");
  await get("/facts");
  assert.equal(EventsResponse.parse(await (await get("/events")).json()).events.filter((e) => e.type === "big_purchase").length, 1);
  const facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.ok(facts.recentEvents.some((e) => e.id === big[0]?.id));
  // small purchases are not big purchases
  await post("/admin/purchase", { amount: 12, merchant: "Starbucks" });
  assert.equal(EventsResponse.parse(await (await get("/events")).json()).events.filter((e) => e.type === "big_purchase").length, 1);
});

test("events page by id: `after` returns only newer events", async () => {
  const { post, get } = await setup();
  await post("/admin/purchase", { amount: 90, merchant: "A" });
  const first = EventsResponse.parse(await (await get("/events")).json()).events;
  const lastId = first.at(-1)!.id;
  await post("/admin/purchase", { amount: 95, merchant: "B" });
  const newer = EventsResponse.parse(await (await get(`/events?after=${lastId}`)).json()).events;
  assert.deepEqual(newer.map((e) => e.type), ["big_purchase"]);
});

test("jump-days fast-forwards the clock, settles the days and raises paycheck and bill events", async () => {
  const { post, get, store, backend } = await setup();
  const r = await post("/admin/sim/jump-days", { days: 13 }); // Nov 20: payday
  assert.equal(r.status, 200);
  assert.equal((await store.read()).offsetSeconds, 13 * 86400);
  const state = await backend.engine.state();
  assert.equal(state.today, "2026-11-20");
  assert.equal(state.settledThrough, "2026-11-19");
  const types = EventsResponse.parse(await (await get("/events")).json()).events.map((e) => e.type);
  assert.ok(!types.includes("paycheck_landed")); // Nov 20 itself is not settled yet; it lands in tomorrow's settle
  await post("/admin/sim/jump-days", { days: 1 });
  const after = EventsResponse.parse(await (await get("/events")).json()).events;
  assert.equal(after.filter((e) => e.type === "paycheck_landed").length, 1);
  const facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.equal(facts.localDate, "2026-11-21");
  assert.equal(facts.forecast.nextPayday, "2026-12-04");
  assert.equal((await post("/admin/sim/jump-days", { days: -1 })).status, 400);
});

test("rent week: bill_due_soon, then a forecast_problem when a big purchase opens a gap", async () => {
  const { post, get } = await setup();
  await post("/admin/sim/jump-days", { days: 21 }); // Nov 28: rent is 3 days out
  let events = EventsResponse.parse(await (await get("/events")).json()).events;
  const due = events.find((e) => e.id === "evt_bill_due_soon_rent_2026-12-01");
  assert.ok(due, "rent bill_due_soon");
  assert.equal(due?.data.daysUntil, 3);
  assert.ok(!events.some((e) => e.type === "forecast_problem"));

  await post("/admin/purchase", { amount: 900, merchant: "Best Buy" });
  events = EventsResponse.parse(await (await get("/events")).json()).events;
  const problem = events.find((e) => e.type === "forecast_problem");
  assert.ok(problem, "forecast_problem after the purchase");
  const facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.ok(facts.shortfall);
  assert.equal(problem?.data.firstNegativeDate, facts.shortfall?.firstNegativeDate);
});

test("a transfer moves money and raises user_transfer_seen", async () => {
  const { post, get } = await setup();
  const r = await post("/admin/transfer", { from: "savings", to: "checking", amount: 143 });
  assert.equal(r.status, 200);
  const facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.equal(facts.accounts.find((a) => a.id === "savings")?.balance, 757);
  assert.equal(facts.accounts.find((a) => a.id === "checking")?.balance, 1329.5);
  const ev = EventsResponse.parse(await (await get("/events")).json()).events.find((e) => e.type === "user_transfer_seen");
  assert.deepEqual([ev?.data.amount, ev?.data.from, ev?.data.to], [143, "savings", "checking"]);
  assert.equal((await post("/admin/transfer", { from: "savings", to: "savings", amount: 5 })).status, 400);
});

test("paycheck now restarts the biweekly schedule; a one-off bill appears in upcoming bills", async () => {
  const { post, get } = await setup();
  await post("/admin/paycheck", {});
  await post("/admin/bill", { label: "Vet", amount: 220, dueInDays: 1 });
  const facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.equal(facts.forecast.nextPayday, "2026-11-21");
  assert.ok(facts.upcomingBills.some((b) => b.label === "Vet" && b.dueDate === "2026-11-08" && b.amount === 220));
  assert.equal(facts.accounts.find((a) => a.id === "checking")?.balance, 1186.5 + 1650);
});

test("scenario shortfall opens the $143 gap at once; reset puts everything back", async () => {
  const { post, get, store } = await setup();
  await post("/admin/sim/jump-days", { days: 5 });
  await post("/admin/sim/demo-mode", { on: true });
  assert.equal((await store.read()).demoMode, true);

  await post("/admin/scenario", { scenario: "shortfall" });
  let facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.equal(facts.shortfall?.suggestedTransfer, 143);
  assert.equal(facts.shortfall?.within48Hours, true);
  assert.deepEqual(await store.read().then((s) => [s.offsetSeconds, s.demoMode]), [0, false]);
  const kinds = EventsResponse.parse(await (await get("/events")).json()).events.map((e) => e.type);
  assert.ok(kinds.includes("forecast_problem"));

  await post("/admin/reset");
  facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.equal(facts.shortfall, null);
  assert.equal(facts.forecast.lowest.balance, 147.5);
  const after = EventsResponse.parse(await (await get("/events")).json()).events.map((e) => e.type);
  assert.ok(!after.includes("forecast_problem"));
});

test("state survives a restart; the event log is not repeated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "huddlr-finance-"));
  try {
    const file = join(dir, "ledger.json");
    const first = await setup({ dataFile: file });
    await first.post("/admin/purchase", { amount: 200, merchant: "Apple" });
    const before = EventsResponse.parse(await (await first.get("/events")).json()).events;

    const second = await setup({ dataFile: file });
    const facts = FactsSnapshot.parse(await (await second.get("/facts")).json());
    assert.equal(facts.accounts.find((a) => a.id === "checking")?.balance, 986.5);
    const again = EventsResponse.parse(await (await second.get("/events")).json()).events;
    assert.deepEqual(again.map((e) => e.id), before.map((e) => e.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending proposals and accept are forwarded to the agents gateway", async () => {
  const proposal: ProposalSummary = {
    id: "7", actionText: "Move $143 from Savings to Checking", amount: 143, from: "savings", to: "checking", status: "pending", expiresAt: "2026-11-07T18:00:00.000Z",
  };
  const calls: string[] = [];
  const gateway: ProposalGateway = {
    async pending() {
      return proposal;
    },
    async accept(id, via) {
      calls.push(`${id}:${via}`);
      return { ok: true, status: "accepted", reason: null, message: "ok" };
    },
    async open() {
      return [proposal];
    },
    async complete() {
      return false;
    },
  };
  const { post, get } = await setup({ gateway });
  const facts = FactsSnapshot.parse(await (await get("/facts")).json());
  assert.deepEqual(facts.pendingProposals.map((p) => p.id), ["7"]);
  const pending = await (await post(ENDPOINTS.tools.get_pending_proposal.path)).json();
  assert.equal((pending as { proposal: ProposalSummary }).proposal.id, "7");
  const acc = AcceptProposalResponse.parse(await (await post(ENDPOINTS.tools.accept_proposal.path, { proposalId: "7", via: "voice" })).json());
  assert.equal(acc.ok, true);
  assert.deepEqual(calls, ["7:voice"]);
});

test("admin engine routes validate their bodies and the stub says they are engine only", async () => {
  const { post } = await setup();
  assert.equal((await post("/admin/purchase", { amount: -5 })).status, 400);
  assert.equal((await post("/admin/purchase", {})).status, 400);
  assert.equal((await post("/admin/bill", { label: "x", amount: 5, dueDate: "tomorrow" })).status, 400);
  assert.equal((await post("/admin/sim/demo-mode", { on: "yes" })).status, 400);
});

test("sim_state stores: file round trip, and the SQL the agents service reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "huddlr-sim-"));
  try {
    const file = new FileSimStateStore(join(dir, "sim.json"));
    assert.equal((await file.read()).offsetSeconds, 0);
    await file.write({ offsetSeconds: 86400, demoMode: true, updatedAt: "2026-11-07T16:00:00.000Z" });
    assert.deepEqual(await file.read(), { offsetSeconds: 86400, demoMode: true, updatedAt: "2026-11-07T16:00:00.000Z" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const sql: string[] = [];
  const row = { offset_seconds: "172800", demo_mode: true, updated_at: new Date("2026-11-07T16:00:00.000Z") };
  const db: Queryable = {
    async query<R>(text: string) {
      sql.push(text);
      return { rows: (text.startsWith("SELECT") ? [row] : []) as R[] };
    },
  };
  const pg = new PgSimStateStore(db);
  assert.deepEqual(await pg.read(), { offsetSeconds: 172800, demoMode: true, updatedAt: "2026-11-07T16:00:00.000Z" });
  await pg.write({ offsetSeconds: 0, demoMode: false, updatedAt: "2026-11-07T16:00:00.000Z" });
  assert.ok(sql.some((s) => s.includes("CREATE TABLE IF NOT EXISTS sim_state") && s.includes("offset_seconds") && s.includes("demo_mode")));
  assert.equal(sql.filter((s) => s.includes("CREATE TABLE")).length, 1); // schema is ensured once
});
