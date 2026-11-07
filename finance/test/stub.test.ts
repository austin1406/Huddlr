import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AcceptProposalResponse,
  CanIAffordResponse,
  ENDPOINTS,
  EventsResponse,
  FactsSnapshot,
  GetPendingProposalResponse,
  Plan,
  TOOL_AUTH_HEADER,
  WhatIfResult,
} from "../../contracts/src";
import { createApp } from "../src/app";
import { StubBackend } from "../src/stub/backend";
import { StubState } from "../src/stub/state";

const SECRET = "test-secret";
const auth = { [TOOL_AUTH_HEADER]: SECRET };
const json = { ...auth, "content-type": "application/json" };

function setup(scenario: "normal" | "shortfall" = "normal") {
  return createApp({ secret: SECRET, backend: new StubBackend(new StubState(scenario)) });
}
const post = (app: ReturnType<typeof setup>, path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: json, body: JSON.stringify(body) });

test("/health needs no secret; everything else does", async () => {
  const app = setup();
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/facts")).status, 401);
  assert.equal((await app.request("/facts", { headers: { [TOOL_AUTH_HEADER]: "wrong" } })).status, 401);
  assert.equal((await post(app, "/tools/get_snapshot")).status, 200);
  const noAuth = await app.request("/tools/get_snapshot", { method: "POST", body: "{}" });
  assert.equal(noAuth.status, 401);
});

test("with no secret configured (local dev) requests are allowed", async () => {
  const app = createApp({ secret: "", backend: new StubBackend() });
  assert.equal((await app.request("/facts")).status, 200);
});

test("/facts serves the fixture, and the scenario can be chosen per request or switched live", async () => {
  const app = setup();
  const normal = FactsSnapshot.parse(await (await app.request("/facts", { headers: auth })).json());
  assert.equal(normal.shortfall, null);

  const short = FactsSnapshot.parse(await (await app.request("/facts?scenario=shortfall", { headers: auth })).json());
  assert.equal(short.shortfall?.within48Hours, true);

  assert.equal((await post(app, "/admin/scenario", { scenario: "shortfall" })).status, 200);
  const switched = FactsSnapshot.parse(await (await app.request("/facts", { headers: auth })).json());
  assert.equal(switched.shortfall?.amount, 43);
  assert.equal((await post(app, "/admin/scenario", { scenario: "bogus" })).status, 400);
});

test("every response carries the stub marker header", async () => {
  const res = await setup().request("/health");
  assert.equal(res.headers.get("x-huddlr-data"), "fixture");
});

test("get_snapshot matches /facts", async () => {
  const app = setup();
  const snap = FactsSnapshot.parse(await (await post(app, ENDPOINTS.tools.get_snapshot.path)).json());
  const facts = FactsSnapshot.parse(await (await app.request("/facts", { headers: auth })).json());
  assert.deepEqual(snap, facts);
});

test("can_i_afford validates input and returns a contract-shaped answer", async () => {
  const app = setup();
  const ok = CanIAffordResponse.parse(await (await post(app, ENDPOINTS.tools.can_i_afford.path, { amount: 40, label: "dinner" })).json());
  assert.equal(ok.verdict, "yes");
  const bad = await post(app, ENDPOINTS.tools.can_i_afford.path, { amount: -5 });
  assert.equal(bad.status, 400);
  assert.equal((await post(app, ENDPOINTS.tools.can_i_afford.path, {})).status, 400);
});

test("what_if and get_plan return contract-shaped answers", async () => {
  const app = setup();
  WhatIfResult.parse(await (await post(app, ENDPOINTS.tools.what_if.path, { scenario: { type: "lose_income", months: 2 } })).json());
  WhatIfResult.parse(await (await post(app, ENDPOINTS.tools.what_if.path, { scenario: { type: "purchase_now", amount: 40 } })).json());
  assert.equal((await post(app, ENDPOINTS.tools.what_if.path, { scenario: { type: "nope" } })).status, 400);
  const plan = Plan.parse(await (await post(app, ENDPOINTS.tools.get_plan.path, { amount: 600, source: "bonus" })).json());
  assert.equal(plan.lines[0]!.destination, "card");
});

test("/events lists oldest first, pages with `after`, and dedupes injected events", async () => {
  const app = setup();
  const all = EventsResponse.parse(await (await app.request("/events", { headers: auth })).json()).events;
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((e) => e.occurredAt), [...all.map((e) => e.occurredAt)].sort());

  const page = EventsResponse.parse(await (await app.request(`/events?after=${all[1]!.id}&limit=2`, { headers: auth })).json()).events;
  assert.deepEqual(page.map((e) => e.id), [all[2]!.id, all[3]!.id]);

  const added = { id: "evt_big_purchase_test-1", type: "big_purchase", occurredAt: "2026-12-03T15:00:00.000Z", severity: "medium", accountId: "card", data: { amount: 99 } };
  assert.deepEqual(await (await post(app, "/admin/events", added)).json(), { added: true });
  assert.deepEqual(await (await post(app, "/admin/events", added)).json(), { added: false });
  const after = EventsResponse.parse(await (await app.request(`/events?after=${all.at(-1)!.id}`, { headers: auth })).json()).events;
  assert.deepEqual(after.map((e) => e.id), ["evt_big_purchase_test-1"]);
  assert.equal((await app.request("/events?limit=0", { headers: auth })).status, 400);
});

test("proposal flow: pending, accept, accept again, then nothing pending", async () => {
  const app = setup("shortfall");
  const pending = GetPendingProposalResponse.parse(await (await post(app, ENDPOINTS.tools.get_pending_proposal.path)).json());
  assert.equal(pending.proposal?.id, "prop_demo_1");

  const first = AcceptProposalResponse.parse(await (await post(app, ENDPOINTS.tools.accept_proposal.path, { proposalId: "prop_demo_1", via: "voice" })).json());
  assert.deepEqual([first.ok, first.status], [true, "accepted"]);

  const again = AcceptProposalResponse.parse(await (await post(app, ENDPOINTS.tools.accept_proposal.path, { proposalId: "prop_demo_1", via: "text" })).json());
  assert.deepEqual([again.ok, again.reason], [false, "already_accepted"]);

  const none = GetPendingProposalResponse.parse(await (await post(app, ENDPOINTS.tools.get_pending_proposal.path)).json());
  assert.equal(none.proposal, null);

  const missing = AcceptProposalResponse.parse(await (await post(app, ENDPOINTS.tools.accept_proposal.path, { proposalId: "nope", via: "voice" })).json());
  assert.equal(missing.reason, "not_found");

  await post(app, "/admin/reset");
  const back = GetPendingProposalResponse.parse(await (await post(app, ENDPOINTS.tools.get_pending_proposal.path)).json());
  assert.equal(back.proposal?.id, "prop_demo_1");
});

test("engine-only admin routes answer 501 in stub mode", async () => {
  const app = setup();
  for (const path of ["/admin/purchase", "/admin/transfer", "/admin/paycheck", "/admin/bill", "/admin/sim/jump-days", "/admin/sim/demo-mode"]) {
    const res = await post(app, path, { amount: 5, on: true, days: 1 });
    assert.equal(res.status, 501, path);
  }
  assert.equal((await app.request("/admin/state", { headers: auth })).status, 501);
});
