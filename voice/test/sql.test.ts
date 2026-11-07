// Runs the call_requests queries against P2's real schema in an in-memory Postgres (PGlite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { makeCallRequestStore, saveCallTx, type Queryable } from "../src/db";
import type { ParsedCall } from "../src/postCall";

const baseCall = (over: Partial<ParsedCall>): ParsedCall => ({
  providerCallId: "conv_1",
  userPhone: "+12145550123",
  direction: "outbound",
  startedAt: new Date(),
  durationMs: 30_000,
  summary: "s",
  decisions: [],
  groundedNumbers: new Set(),
  transcript: [{ speaker: "coach", text: "Hi" }, { speaker: "user", text: "Hey" }],
  callRequestId: null,
  answered: true,
  ...over,
});

const schema = readFileSync(fileURLToPath(new URL("../../contracts/p2_agents.sql", import.meta.url)), "utf8");

async function setup() {
  const pg = new PGlite();
  await pg.exec(schema);
  const db = pg as unknown as Queryable;
  const insert = (phone: string, type: string, status = "pending") =>
    pg.query<{ id: number }>(
      `INSERT INTO call_requests (user_phone, type, shortfall, status, created_sim_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [phone, type, type === "emergency" ? { amount_cents: 4300, date: "2026-12-02", account: "checking" } : null, status],
    );
  return { pg, store: makeCallRequestStore(db), insert };
}

test("claimNext takes emergencies first and moves them to calling", async () => {
  const { pg, store, insert } = await setup();
  await insert("+1", "monthly_recap");
  await insert("+2", "emergency");
  const first = await store.claimNext({ includeRecap: true });
  assert.equal(first?.type, "emergency");
  assert.equal(first?.shortfall?.amount_cents, 4300);
  const s = await pg.query<{ status: string }>("SELECT status FROM call_requests WHERE id = $1", [first!.id]);
  assert.equal(s.rows[0].status, "calling");
  assert.equal((await store.claimNext({ includeRecap: true }))?.type, "monthly_recap");
  assert.equal(await store.claimNext({ includeRecap: true }), null);
});

test("claimNext skips the recap when includeRecap is false", async () => {
  const { store, insert } = await setup();
  await insert("+1", "monthly_recap");
  assert.equal(await store.claimNext({ includeRecap: false }), null);
});

test("stale finds calling rows older than the cutoff", async () => {
  const { pg, store, insert } = await setup();
  const { rows } = await insert("+1", "emergency", "calling");
  assert.equal((await store.stale(60_000)).length, 0);
  await pg.query("UPDATE call_requests SET updated_at = now() - interval '20 minutes' WHERE id = $1", [rows[0].id]);
  assert.equal((await store.stale(15 * 60_000)).length, 1);
});

test("fallback text lands in the outbox once, at emergency priority", async () => {
  const { pg, store, insert } = await setup();
  await insert("+12145550123", "emergency");
  const req = (await store.claimNext({ includeRecap: true }))!;
  await store.setStatus(req.id, "no_answer");
  await store.queueFallbackText(req, "text", new Date());
  await store.queueFallbackText(req, "text", new Date());
  const out = await pg.query<{ priority: number; idempotency_key: string }>("SELECT priority, idempotency_key FROM outbox");
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].priority, 2);
  assert.equal(out.rows[0].idempotency_key, `callreq:${req.id}:fallback`);
});

test("saveCall: answered call saves call + transcript + one recap, idempotent on retries", async () => {
  const { pg, insert } = await setup();
  const db = pg as unknown as Queryable;
  const { rows } = await insert("+12145550123", "emergency", "calling");
  const call = baseCall({ callRequestId: rows[0].id, decisions: [] });
  assert.equal((await saveCallTx(db, call, "📞 Call recap", new Date())).saved, true);
  assert.equal((await saveCallTx(db, call, "📞 Call recap", new Date())).saved, false);
  const calls = await pg.query<{ call_request_id: number }>("SELECT call_request_id FROM calls");
  assert.deepEqual(calls.rows.map((r) => Number(r.call_request_id)), [rows[0].id]);
  assert.equal((await pg.query("SELECT 1 FROM memory_messages")).rows.length, 2);
  const out = await pg.query<{ text: string; priority: number }>("SELECT text, priority FROM outbox");
  assert.deepEqual(out.rows, [{ text: "📞 Call recap", priority: 1 }]);
  const st = await pg.query<{ status: string }>("SELECT status FROM call_requests");
  assert.equal(st.rows[0].status, "answered");
});

test("saveCall: unanswered outbound call sends the fallback text, not a recap", async () => {
  const { pg, insert } = await setup();
  const db = pg as unknown as Queryable;
  const { rows } = await insert("+12145550123", "emergency", "calling");
  await saveCallTx(db, baseCall({ callRequestId: rows[0].id, answered: false, transcript: [{ speaker: "coach", text: "Hi" }] }), "recap", new Date());
  const out = await pg.query<{ text: string; priority: number }>("SELECT text, priority FROM outbox");
  assert.equal(out.rows.length, 1);
  assert.match(out.rows[0].text, /I tried calling.*\$43\.00 short/);
  assert.equal(out.rows[0].priority, 2);
  assert.equal((await pg.query<{ status: string }>("SELECT status FROM call_requests")).rows[0].status, "no_answer");
});
