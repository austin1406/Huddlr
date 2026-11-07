// Event -> debate, end to end, against P1's real finance stub app (in-process) and an in-memory Postgres.
// If P1 and P2 ever disagree on a shape, this fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { TOOL_AUTH_HEADER, type FinanceEvent } from "../../contracts/src";
import { createApp as createFinanceApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { checkMessage } from "../src/checker";
import { factsFor } from "../src/character";
import { migrate } from "../src/db";
import { maybeSendDigest, planAmount, pollEvents, proposalFromPlan, runEvent, type DebateDeps } from "../src/debate";
import { financeClient } from "../src/finance";
import { makeProposalService } from "../src/proposals";
import { handleInbound } from "../src/replies";

const PHONE = "+12145550123";
const SECRET = "s3cret";

/** Fake model that always invents a number, so every message must come out of the checker grounded. */
const liar = async () => "Only $9,999.99 left, trust me!";

async function setup(scenario: "normal" | "shortfall", opts: { demoMode?: boolean; at?: string } = {}) {
  const db = new PGlite();
  await migrate(db);
  const state = new StubState(scenario);
  const app = createFinanceApp({ secret: SECRET, state });
  const finance = financeClient("http://finance", SECRET, 4000, ((url: string, init?: RequestInit) => app.request(url.replace("http://finance", ""), init)) as typeof fetch);
  const facts = await finance.facts();
  // Simulated time: the fixture's own asOf (a weekday morning) unless the test says otherwise.
  let t = new Date(opts.at ?? facts.asOf).getTime();
  const proposals = makeProposalService(db, () => new Date(t));
  const deps: DebateDeps = { db, finance, proposals, userPhone: PHONE, clock: async () => ({ now: new Date(t), demoMode: opts.demoMode ?? false }), model: liar };
  const outbox = async () =>
    (await db.query<{ speaker: string; text: string; priority: number; proposal_id: number | null; event_id: string }>(
      "SELECT speaker, text, priority, proposal_id, event_id FROM outbox ORDER BY id",
    )).rows;
  return { db, state, finance, facts, proposals, deps, outbox, jump: (ms: number) => { t += ms; } };
}

const event = (over: Partial<FinanceEvent> & Pick<FinanceEvent, "id" | "type">): FinanceEvent => ({
  occurredAt: "2026-12-02T15:00:00.000Z", severity: "high", accountId: "checking", data: {}, ...over,
});

test("rent-week shortfall: accounts speak, Coach goes last with P1's plan and a $143 proposal", async () => {
  const { deps, outbox, proposals, facts } = await setup("shortfall");
  const r = await runEvent(deps, event({ id: "evt_forecast_problem_test", type: "forecast_problem" }));
  assert.equal(r.decision, "react");
  assert.ok(r.firstMessageMs != null && r.planMs != null);

  const sent = await outbox();
  assert.ok(sent.length >= 2 && sent.length <= 3, `got ${sent.length} messages`);
  assert.equal(sent.at(-1)!.speaker, "coach", "Coach always last");
  assert.ok(sent.every((m) => m.priority === 2), "a within-48h shortfall is an emergency");
  assert.match(sent.at(-1)!.text, /Reply YES to: Move \$143\.00 from Savings to Checking/);

  const pending = await proposals.getPending(PHONE);
  assert.equal(pending?.amount, facts.shortfall!.suggestedTransfer);
  assert.equal(sent.at(-1)!.proposal_id, Number(pending!.id));
});

test("every message the debate queues is grounded, even with a model that always lies", async () => {
  const { deps, outbox, facts } = await setup("shortfall");
  await runEvent(deps, event({ id: "evt_forecast_problem_x", type: "forecast_problem" }));
  for (const m of await outbox()) {
    if (m.speaker === "coach") continue; // Coach is checked against facts + plan inside speak()
    const r = checkMessage(m.text, factsFor(m.speaker as never, facts, event({ id: "x", type: "forecast_problem" })));
    assert.deepEqual(r.ungrounded, [], `${m.speaker}: ${m.text}`);
  }
});

test("then the user texts YES: proposal accepted and the Coach confirms", async () => {
  const { db, deps, proposals, outbox } = await setup("shortfall");
  await runEvent(deps, event({ id: "evt_forecast_problem_y", type: "forecast_problem" }));
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('m1', $1, 'YES', now())", [PHONE]);
  const r = await handleInbound(db, proposals, { id: 1, user_phone: PHONE, text: "YES" }, (await deps.clock()).now);
  assert.equal(r.kind, "accepted");
  assert.match((await outbox()).at(-1)!.text, /Locked in: Move \$143\.00 from Savings to Checking/);
});

test("never reacts to the same event id twice", async () => {
  const { deps, outbox } = await setup("shortfall");
  const e = event({ id: "evt_forecast_problem_dup", type: "forecast_problem" });
  await runEvent(deps, e);
  const n = (await outbox()).length;
  assert.equal((await runEvent(deps, e)).decision, "duplicate");
  assert.equal((await outbox()).length, n);
});

test("pollEvents reads P1's /events once, keeps a cursor, and a second poll does nothing new", async () => {
  const { deps, outbox, state } = await setup("normal", { demoMode: true });
  const first = await pollEvents(deps);
  assert.equal(first.length, state.listEvents().length);
  const n = (await outbox()).length;
  assert.equal((await pollEvents(deps)).length, 0);
  assert.equal((await outbox()).length, n);
});

test("quiet hours hold a normal event for the evening digest, which is sent once", async () => {
  // 11 pm Chicago on Nov 7 (05:00Z Nov 8).
  const { deps, outbox, jump } = await setup("normal", { at: "2026-11-08T05:00:00.000Z" });
  const r = await runEvent(deps, event({ id: "evt_big_purchase_late", type: "big_purchase", severity: "medium", accountId: "card", data: { merchant: "Target", amount: 142.37 } }));
  assert.equal(r.decision, "digest");
  assert.equal((await outbox()).length, 0);

  // Next evening 7:30 pm Chicago (01:30Z), the event is from "yesterday" local time, so no digest for today.
  jump(20.5 * 3600_000);
  assert.equal(await maybeSendDigest(deps, "America/Chicago"), false);
});

test("digest goes out at digest time for events held back today, only once", async () => {
  // 6 pm Chicago: daily cap reached, so the event is held.
  const { db, deps, outbox, jump } = await setup("normal", { at: "2026-11-08T00:00:00.000Z" });
  for (let i = 0; i < 6; i++)
    await db.query(
      "INSERT INTO outbox (idempotency_key, user_phone, speaker, text, priority, created_sim_at) VALUES ($1, $2, 'card', 'x', 0, $3)",
      [`filler${i}`, PHONE, "2026-11-07T23:00:00.000Z"],
    );
  const r = await runEvent(deps, event({ id: "evt_big_purchase_cap", type: "big_purchase", severity: "medium", accountId: "card", data: { merchant: "Target", amount: 142.37 } }));
  assert.equal(r.decision, "digest");
  assert.equal(await maybeSendDigest(deps, "America/Chicago"), false, "before 7 pm: not yet");
  jump(3600_000 + 60_000); // 7:01 pm
  assert.equal(await maybeSendDigest(deps, "America/Chicago"), true);
  assert.equal(await maybeSendDigest(deps, "America/Chicago"), false, "only once a day");
  assert.match((await outbox()).at(-1)!.text, /Target for \$142\.37/);
});

test("plan helpers: shortfall amount, paycheck surplus, comment-only otherwise", async () => {
  const { facts: short } = await setup("shortfall");
  const { facts: normal, finance } = await setup("normal");
  assert.equal(planAmount(event({ id: "a", type: "big_purchase" }), short), short.shortfall!.suggestedTransfer);
  assert.equal(planAmount(event({ id: "b", type: "paycheck_landed" }), normal), normal.forecast.safeToSpendUntilPayday);
  assert.equal(planAmount(event({ id: "c", type: "big_purchase" }), normal), null);
  const ask = proposalFromPlan(await finance.plan(normal.forecast.safeToSpendUntilPayday));
  assert.ok(ask && ask.from === "checking", JSON.stringify(ask));
});

test("the outbox carries the secret-protected finance call (wrong secret fails loudly)", async () => {
  const state = new StubState("normal");
  const app = createFinanceApp({ secret: SECRET, state });
  const bad = financeClient("http://finance", "wrong", 4000, ((url: string, init?: RequestInit) => app.request(url.replace("http://finance", ""), init)) as typeof fetch);
  await assert.rejects(bad.facts(), /401/);
  assert.equal(TOOL_AUTH_HEADER, "x-huddlr-secret");
});
