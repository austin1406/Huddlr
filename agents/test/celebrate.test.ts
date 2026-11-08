// Celebrations (good money moves get a cheer) and @-mentions (text one character directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { FactsSnapshot, type FinanceEvent } from "../../contracts/src";
import { createApp as createFinanceApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { celebration, celebrationTiming } from "../src/celebrate";
import { handleChat, parseMention } from "../src/chat";
import { checkMessage } from "../src/checker";
import { cushionWords } from "../src/character";
import { migrate } from "../src/db";
import { runEvent, type DebateDeps } from "../src/debate";
import { financeClient, type Finance } from "../src/finance";
import { makeProposalService } from "../src/proposals";

const facts = FactsSnapshot.parse(JSON.parse(readFileSync(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url), "utf8")));
const PHONE = "+12145550123";

const transfer = (to: string, amount: number, id = `evt_user_transfer_seen_t_${to}`): FinanceEvent => ({
  id, type: "user_transfer_seen", occurredAt: facts.asOf, severity: "low", accountId: to as FinanceEvent["accountId"],
  data: { amount, from: to === "checking" ? "savings" : "checking", to, matchedProposalId: null },
});

// ---------- celebrations ----------

test("saving, paying down debt, and investing each get a cheer from that account, every number grounded", () => {
  for (const [to, speaker] of [["savings", "savings"], ["card", "card"], ["car_loan", "car_loan"], ["ira", "ira"]] as const) {
    const event = transfer(to, 150);
    const cheer = celebration(event, facts, false);
    assert.equal(cheer?.speaker, speaker, to);
    assert.match(cheer!.text, /\$150\.00/);
    const check = checkMessage(cheer!.text, facts, event.data, cushionWords(facts));
    assert.equal(check.ok, true, `${to}: ${cheer!.text} -> ${JSON.stringify(check)}`);
  }
  assert.match(celebration(transfer("savings", 150), facts, false)!.text, /enough saved to cover about 2 weeks of must-pay bills/);
  assert.doesNotMatch(celebration(transfer("savings", 150), facts, false)!.text, /months of essentials|runway/);
  assert.match(celebration(transfer("card", 150), facts, false)!.text, /\$2,400\.00 owed/);
});

test("money into Checking is cheered only when it closed a recent shortfall", () => {
  assert.equal(celebration(transfer("checking", 143), facts, false), null, "no recent problem: nothing to celebrate");
  const fixed = celebration(transfer("checking", 143), { ...facts, shortfall: null }, true);
  assert.equal(fixed?.speaker, "checking");
  assert.match(fixed!.text, /gap is closed/);
  const stillShort = { ...facts, shortfall: { amount: 43, firstNegativeDate: "2026-12-02", within48Hours: true, suggestedTransfer: 143 } } as unknown as FactsSnapshot;
  assert.equal(celebration(transfer("checking", 20), stillShort, true), null, "still short: the normal debate runs instead");
});

test("only transfers are celebrations", () => {
  const purchase: FinanceEvent = { id: "evt_big_purchase_x", type: "big_purchase", occurredAt: facts.asOf, severity: "medium", accountId: "card", data: { amount: 300 } };
  assert.equal(celebration(purchase, facts, true), null);
  assert.equal(celebration(transfer("savings", 0), facts, false), null);
});

test("celebrations respect quiet hours and the daily cap; demo mode lifts both", () => {
  const night = new Date("2026-11-08T05:00:00.000Z"); // 11 pm in Chicago
  const day = new Date("2026-11-07T18:00:00.000Z"); // noon in Chicago
  const tz = "America/Chicago";
  assert.equal(celebrationTiming({ now: night, timezone: tz, demoMode: false, proactiveSentToday: 0 }), "digest");
  assert.equal(celebrationTiming({ now: night, timezone: tz, demoMode: true, proactiveSentToday: 0 }), "react");
  assert.equal(celebrationTiming({ now: day, timezone: tz, demoMode: false, proactiveSentToday: 8 }), "digest");
  assert.equal(celebrationTiming({ now: day, timezone: tz, demoMode: false, proactiveSentToday: 2 }), "react");
});

async function eventSetup(opts: { demoMode: boolean; at?: string; factsOverride?: Partial<FactsSnapshot> }) {
  const db = new PGlite();
  await migrate(db);
  const app = createFinanceApp({ secret: "", state: new StubState("normal") });
  const real = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const finance: Finance = { ...real, facts: async () => ({ ...(await real.facts()), ...opts.factsOverride }) };
  const t = new Date(opts.at ?? facts.asOf);
  let modelCalls = 0;
  const deps: DebateDeps = {
    db, finance, proposals: makeProposalService(db, () => t), userPhone: PHONE,
    clock: async () => ({ now: t, demoMode: opts.demoMode }),
    model: async () => { modelCalls++; return "unused"; },
  };
  const outbox = async () => (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id")).rows;
  return { db, deps, outbox, modelCalls: () => modelCalls };
}

test("a transfer into Savings: one cheer, no model call, never twice", async () => {
  const { deps, outbox, modelCalls } = await eventSetup({ demoMode: true });
  const r = await runEvent(deps, transfer("savings", 200));
  assert.equal(r.decision, "react");
  assert.equal(r.reason, "celebration");
  const sent = await outbox();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].speaker, "savings");
  assert.match(sent[0].text, /\$200\.00 just landed/);
  assert.equal(modelCalls(), 0, "templates only: works even when Gemini is rate-limited");
  assert.equal((await runEvent(deps, transfer("savings", 200))).decision, "duplicate");
  assert.equal((await outbox()).length, 1);
});

test("a cheer at night is held for the evening recap", async () => {
  const { db, deps, outbox } = await eventSetup({ demoMode: false, at: "2026-11-08T05:00:00.000Z" });
  const r = await runEvent(deps, transfer("card", 100));
  assert.equal(r.decision, "digest");
  assert.equal((await outbox()).length, 0);
  const row = await db.query<{ outcome: string }>("SELECT outcome FROM agent_event_reactions");
  assert.equal(row.rows[0].outcome, "digested");
});

test("after a shortfall, the transfer that fixes it gets 'crisis averted'", async () => {
  const { db, deps, outbox } = await eventSetup({ demoMode: true, factsOverride: { shortfall: null } });
  await db.query(
    "INSERT INTO agent_event_reactions (event_id, user_phone, outcome, reacted_sim_at) VALUES ('evt_forecast_problem_2026-12-02', $1, 'reacted', $2)",
    [PHONE, new Date(new Date(facts.asOf).getTime() - 3600_000)],
  );
  await runEvent(deps, transfer("checking", 143));
  const [m] = await outbox();
  assert.equal(m.speaker, "checking");
  assert.match(m.text, /\$143\.00 landed and the gap is closed/);
});

// ---------- @-mentions ----------

test("parses a leading @name, with friendly aliases", () => {
  assert.deepEqual(parseMention("@savings how am I doing?"), { who: "savings", rest: "how am I doing?" });
  assert.deepEqual(parseMention("@Piggy, should I worry?"), { who: "savings", rest: "should I worry?" });
  assert.deepEqual(parseMention("@car loan when is it paid off"), { who: "car_loan", rest: "when is it paid off" });
  assert.deepEqual(parseMention("@ira"), { who: "ira", rest: "" });
  assert.deepEqual(parseMention("@coach: what should I do"), { who: "coach", rest: "what should I do" });
  assert.equal(parseMention("@bob hi"), null, "unknown name: normal routing");
  assert.equal(parseMention("email me at a@card.com"), null, "only a leading @ counts");
});

test("@card answers even a savings-sounding question, in its own voice", async () => {
  const db = new PGlite();
  await migrate(db);
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'x', now())", [PHONE]);
  let prompt = "";
  const r = await handleChat(
    { db, facts: async () => facts, userPhone: PHONE, model: async (p) => { prompt = p; return "You owe me $2,400.00. Pay me before you pad savings."; } },
    { id: 1, text: "@card should I put more in savings?" },
    new Date(facts.asOf),
  );
  assert.equal(r.responder, "card", "the mention beats topic routing (which would pick Savings)");
  assert.match(prompt, /tagged you directly/);
  assert.match(prompt, /should I put more in savings\?/);
  assert.doesNotMatch(prompt, /@card/);
  const out = await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox");
  assert.equal(out.rows[0].speaker, "card");
  assert.match(out.rows[0].text, /\$2,400\.00/);
});

test("a bare @savings is a check-in", async () => {
  const db = new PGlite();
  await migrate(db);
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'x', now())", [PHONE]);
  let prompt = "";
  const r = await handleChat({ db, facts: async () => facts, userPhone: PHONE, model: async (p) => { prompt = p; return "I'm holding $900.00."; } }, { id: 1, text: "@savings" }, new Date(facts.asOf));
  assert.equal(r.responder, "savings");
  assert.match(prompt, /How am I doing with you right now\?/);
});
