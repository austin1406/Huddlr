// Reminder -> escalation -> call_requests, on simulated time, against P1's finance stub and an in-memory Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { CallRequestRow, TOOL_AUTH_HEADER, type FinanceEvent } from "../../contracts/src";
import { createApp as createFinanceApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { createApp } from "../src/app";
import { migrate } from "../src/db";
import { runEvent, type DebateDeps } from "../src/debate";
import { financeClient } from "../src/finance";
import { runFollowUps } from "../src/followups";
import { makeProposalService } from "../src/proposals";
import { handleInbound } from "../src/replies";

const PHONE = "+12145550123";
const MIN = 60_000;

async function setup(scenario: "shortfall" | "normal" = "shortfall") {
  const db = new PGlite();
  await migrate(db);
  const fin = createFinanceApp({ secret: "", state: new StubState(scenario) });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => fin.request(u.replace("http://f", ""), i)) as typeof fetch);
  const facts = await finance.facts();
  let t = new Date(facts.asOf).getTime();
  const now = () => new Date(t);
  const proposals = makeProposalService(db, now);
  const deps: DebateDeps = { db, finance, proposals, userPhone: PHONE, clock: async () => ({ now: now(), demoMode: false }), model: async () => "x" };
  const tick = () => runFollowUps({ db, proposals, userPhone: PHONE, now: now(), facts });
  const outbox = async () => (await db.query<{ text: string; priority: number }>("SELECT text, priority FROM outbox ORDER BY id")).rows;
  const calls = async () => (await db.query<Record<string, unknown>>("SELECT * FROM call_requests ORDER BY id")).rows;
  const shortfallEvent: FinanceEvent = { id: "evt_fp", type: "forecast_problem", occurredAt: facts.asOf, severity: "high", accountId: "checking", data: {} };
  await runEvent(deps, shortfallEvent);
  const pending = await proposals.getPending(PHONE);
  const text = async (body: string) => {
    const r = await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`m${Math.random()}`, PHONE, body, now()],
    );
    return handleInbound(db, proposals, { id: Number(r.rows[0].id), user_phone: PHONE, text: body }, now());
  };
  return { db, proposals, facts, pending, tick, outbox, calls, text, now, jump: (ms: number) => { t += ms; } };
}

test("no answer: reminder at 60 min, then at 90 min a call_requests row for P4 plus a heads-up text", async () => {
  const { tick, outbox, calls, jump, pending, facts } = await setup();
  assert.ok(pending, "the shortfall debate created a proposal");
  assert.deepEqual(await tick(), [], "nothing due yet");

  jump(60 * MIN);
  assert.deepEqual((await tick()).map((r) => r.outcome), ["reminded"]);
  assert.match((await outbox()).at(-1)!.text, /still to do, move \$143\.00 from Savings to Checking in your bank app/);

  jump(30 * MIN);
  assert.deepEqual((await tick()).map((r) => r.outcome), ["called"]);
  const row = (await calls())[0];
  const call = CallRequestRow.parse({ ...row, id: Number(row.id), proposal_id: Number(row.proposal_id),
    created_sim_at: new Date(row.created_sim_at as string).toISOString(), created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString() });
  assert.equal(call.type, "emergency");
  assert.equal(call.proposal_id, Number(pending!.id));
  assert.equal(call.shortfall!.amount_cents, Math.round(facts.shortfall!.amount * 100));
  assert.match(call.script_hint!, /will you move \$143\.00 from Savings to Checking today/);
  const last = (await outbox()).at(-1)!;
  assert.equal(last.priority, 2, "emergency text ignores quiet hours");
  assert.match(last.text, /call/);

  jump(60 * MIN);
  assert.deepEqual(await tick(), [], "each follow-up fires once");
});

test("a YES before the cutoff cancels both: no reminder, no call", async () => {
  const { tick, calls, text, jump } = await setup();
  assert.equal((await text("yes")).kind, "accepted");
  jump(120 * MIN);
  assert.deepEqual((await tick()).map((r) => r.outcome), ["skipped", "skipped"]);
  assert.equal((await calls()).length, 0);
});

test("a NO is respected: no call", async () => {
  const { tick, calls, text, jump } = await setup();
  assert.equal((await text("no thanks")).kind, "declined");
  jump(120 * MIN);
  await tick();
  assert.equal((await calls()).length, 0);
});

test("P1's watcher completes the transfer: the Coach says it saw it, once", async () => {
  const { db, proposals, pending, outbox, now } = await setup();
  const app = createApp({ db, proposals, secret: "k", demoUserPhone: PHONE, now });
  const complete = () =>
    app.request(`/agents/proposals/${pending!.id}/complete`, {
      method: "POST", headers: { "content-type": "application/json", [TOOL_AUTH_HEADER]: "k" }, body: JSON.stringify({ txnId: "nessie-1" }),
    });
  assert.equal((await complete()).status, 200);
  assert.equal((await complete()).status, 409);
  const acks = (await outbox()).filter((m) => /Saw it/.test(m.text));
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /you moved \$143\.00 from Savings to Checking/);
});

test("a YES after the call was requested cancels the call before P4 places it", async () => {
  const { tick, calls, text, jump } = await setup();
  jump(90 * MIN);
  await tick();
  assert.equal((await calls())[0].status, "pending");
  assert.equal((await text("yes")).kind, "accepted");
  assert.equal((await calls())[0].status, "cancelled");
});
