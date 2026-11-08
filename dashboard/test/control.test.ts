import { test } from "node:test";
import assert from "node:assert/strict";
import { daytimeNudge, runControl, type ControlDeps } from "../src/control.js";

const TZ = "America/Chicago";

test("fast-forward lands in daytime: 23:30 local → 10:00 next morning", () => {
  // 2026-11-08 05:30Z = Nov 7, 23:30 in Chicago (CST, UTC-6)
  assert.equal(Math.round(daytimeNudge("2026-11-08T05:30:00Z", TZ) * 24 * 10) / 10, 10.5);
  // 15:00 local is already daytime
  assert.equal(daytimeNudge("2026-11-07T21:00:00Z", TZ), 0);
  // 06:00 local → 4 hours later
  assert.equal(Math.round(daytimeNudge("2026-11-07T12:00:00Z", TZ) * 24), 4);
});

function fakeDeps(handler: (url: string, body: any) => { status?: number; json: any }) {
  const calls: { url: string; body: any; secret: string | null }[] = [];
  const deps: ControlDeps = {
    financeUrl: "http://fin",
    agentsUrl: "http://agents",
    secret: "s3cret",
    timezone: TZ,
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body, secret: (init.headers as Record<string, string>)["x-huddlr-secret"] ?? null });
      const r = handler(url, body);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }) as typeof fetch,
  };
  return { deps, calls };
}

test("jump nudges a night landing into daytime with a second jump", async () => {
  let n = 0;
  const { deps, calls } = fakeDeps(() => ({ json: { state: { now: n++ === 0 ? "2026-11-09T05:30:00Z" : "2026-11-09T16:00:00Z" } } }));
  const r = await runControl("jump", { days: 1 }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.url), ["http://fin/admin/sim/jump-days", "http://fin/admin/sim/jump-days"]);
  assert.equal(calls[0].body.days, 1);
  assert.equal(Math.round(calls[1].body.days * 24 * 10) / 10, 10.5);
  assert.ok(calls.every((c) => c.secret === "s3cret"));
});

test("reset clears finance then agents; purchase forwards only known fields", async () => {
  const { deps, calls } = fakeDeps(() => ({ json: { ok: true } }));
  await runControl("reset", {}, deps);
  await runControl("purchase", { amount: 14, merchant: "Chipotle", account: "card", evil: "x", category: "" }, deps);
  assert.deepEqual(calls.map((c) => c.url), ["http://fin/admin/reset", "http://agents/agents/reset", "http://fin/admin/purchase"]);
  assert.deepEqual(calls[2].body, { amount: 14, merchant: "Chipotle", account: "card" });
});

test("finance validation errors come back to the page as 400 with the message", async () => {
  const { deps } = fakeDeps(() => ({ status: 400, json: { error: "invalid_request" } }));
  const r = await runControl("transfer", { from: "savings", to: "savings", amount: 5 }, deps);
  assert.deepEqual(r, { ok: false, status: 400, result: { error: "invalid_request" } });
  assert.equal((await runControl("explode", {}, deps)).status, 400);
});
