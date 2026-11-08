// The user's money priorities ("prioritize my IRA over savings", "pay off the card first") and the account summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Plan } from "../../contracts/src";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { handleChat } from "../src/chat";
import { migrate } from "../src/db";
import { proposalFromPlan, runWindfall } from "../src/debate";
import { financeClient, type Finance } from "../src/finance";
import { loadPriorities, mergePriorities, parsePriorities, pickLine } from "../src/priorities";
import { makeProposalService } from "../src/proposals";
import { accountSummary, isSummaryQuestion } from "../src/summary";

const PHONE = "+12145550123";

// The plan from the phone test: $600 bonus -> $150 IRA (match), $450 Card.
const phonePlan: Plan = {
  schemaVersion: 1, asOf: "2026-11-07T16:00:00.000Z", amount: 600, shortfallCovered: 0, unallocated: 0,
  lines: [
    { destination: "ira", amount: 150, reasonCode: "capture_employer_match", reasonNumbers: { unclaimedMatchThisYear: 150 } },
    { destination: "card", amount: 450, reasonCode: "pay_high_interest_debt", reasonNumbers: { aprPercent: 24, monthlyInterestSaved: 9 } },
  ],
};
const shortPlan: Plan = {
  ...phonePlan, shortfallCovered: 143,
  lines: [{ destination: "checking", amount: 143, reasonCode: "cover_shortfall", reasonNumbers: {} }, ...phonePlan.lines.slice(1)],
};

test("parses the ways people say what matters to them", () => {
  assert.deepEqual(parsePriorities("i wanna prioritize my ira over savings right now"), { first: ["ira"], last: ["savings"] });
  assert.deepEqual(parsePriorities("pay off the card first"), { first: ["card"] });
  assert.deepEqual(parsePriorities("card first, then savings"), { first: ["card", "savings"] });
  assert.deepEqual(parsePriorities("retirement is more important than debt"), { first: ["ira"], last: ["card"] });
  assert.deepEqual(parsePriorities("I care more about savings than the card"), { first: ["savings"], last: ["card"] });
  assert.deepEqual(parsePriorities("don't touch my savings"), { protect: ["savings"] });
  assert.deepEqual(parsePriorities("savings can wait"), { last: ["savings"] });
  assert.deepEqual(parsePriorities("reset my priorities"), { clear: true });
  for (const t of ["how is my savings over the month", "what's my card balance", "can i put more into savings", "I got a $600 bonus"])
    assert.equal(parsePriorities(t), null, t);
});

test("merging: the newest statement wins, nothing is both first and last", () => {
  const a = mergePriorities(null, { first: ["ira"], last: ["savings"] });
  const b = mergePriorities(a, { first: ["savings"] });
  assert.deepEqual(b, { first: ["savings", "ira"], last: [], protect: [] });
  assert.deepEqual(mergePriorities(b, { clear: true }), { first: [], last: [], protect: [] });
});

test("the YES follows priorities, but a shortfall is always covered first", () => {
  assert.equal(pickLine(phonePlan, null)?.destination, "ira", "no priorities: P1's order");
  assert.equal(pickLine(phonePlan, { first: ["card"], last: [], protect: [] })?.destination, "card");
  assert.equal(pickLine(phonePlan, { first: [], last: ["ira"], protect: [] })?.destination, "card", "ranked last loses");
  assert.equal(pickLine(shortPlan, { first: ["card"], last: [], protect: [] })?.destination, "checking", "safety first");
  assert.equal(proposalFromPlan(phonePlan, { first: ["card"], last: [], protect: [] }, { windfall: true })?.actionText, "Move $450.00 from Checking to Card");
});

async function setup(planOverride?: Plan) {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const real = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const asked: unknown[] = [];
  const finance: Finance = { ...real, plan: async (amount, opts) => { asked.push(opts?.priorities ?? null); return planOverride ?? real.plan(amount, opts); } };
  const now = new Date((await real.facts()).asOf);
  const proposals = makeProposalService(db, () => now);
  let n = 0;
  const model = async () => "Here's the plan. Reply YES to: Move $450.00 from Checking to Card.";
  const chat = async (text: string) => {
    const id = Number((await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id", [`m${++n}`, PHONE, text, now],
    )).rows[0].id);
    await db.query("INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at) VALUES ($1, 'text', 'in', 'user', $2, $3, $4)", [PHONE, text, id, now]);
    return handleChat({ db, facts: () => finance.facts(), userPhone: PHONE, finance, proposals, model,
      windfall: (ask, t) => runWindfall({ db, finance, proposals, userPhone: PHONE, model }, ask, t) }, { id, text }, now);
  };
  const last = async () => (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id DESC LIMIT 1")).rows[0];
  return { db, chat, last, proposals, asked, now };
}

test("phone test: 'prioritize my ira over savings' is saved, confirmed, and the waiting plan already starts with IRA", async () => {
  const { chat, last, proposals, db } = await setup(phonePlan);
  await chat("I got a $600 bonus, what should I do?");
  assert.equal((await proposals.getPending(PHONE))?.actionText, "Move $150.00 from Checking to IRA");

  const r = await chat("i wanna prioritize my ira over savings right now");
  assert.equal(r.responder, "coach");
  const m = await last();
  assert.match(m.text, /^Got it: IRA comes before Savings when there's money to place\. A shortfall in Checking still gets covered first/);
  assert.match(m.text, /Your plan already starts there\. Reply YES to: Move \$150\.00 from Checking to IRA\.$/);
  assert.deepEqual(await loadPriorities(db, PHONE), { first: ["ira"], last: ["savings"], protect: [] });
});

test("'pay off the card first' re-points the waiting plan: the YES now moves money to the Card", async () => {
  const { chat, last, proposals } = await setup(phonePlan);
  await chat("I got a $600 bonus, what should I do?");
  const before = await proposals.getPending(PHONE);
  await chat("pay off the card first");
  const after = await proposals.getPending(PHONE);
  assert.equal(after?.actionText, "Move $450.00 from Checking to Card");
  assert.notEqual(after?.id, before?.id, "a new plan replaces the old one, so the old YES can't approve it");
  assert.match((await last()).text, /I've updated the plan\. Reply YES to: Move \$450\.00 from Checking to Card\.$/);
});

test("priorities carry into the next plan and are sent to P1's planner", async () => {
  const { chat, proposals, asked } = await setup(phonePlan);
  await chat("pay off the card first");
  await chat("I got a $600 bonus, what should I do?");
  assert.equal((await proposals.getPending(PHONE))?.actionText, "Move $450.00 from Checking to Card");
  assert.deepEqual(asked.at(-1), { first: ["card"], last: [], protect: [] });
});

test("a priority the waiting plan has no money for is saved for next time, honestly", async () => {
  const { chat, last } = await setup(phonePlan);
  await chat("I got a $600 bonus, what should I do?");
  await chat("focus on savings");
  assert.match((await last()).text, /doesn't put anything in Savings; it goes first next time there's money to place\. Still waiting on your YES: Move \$150\.00 from Checking to IRA\./);
});

test("account summary: every account, priorities and the waiting plan, built in code", async () => {
  for (const t of ["can u give me a summary of my account", "where do I stand", "give me an overview", "how am i doing overall"]) assert.equal(isSummaryQuestion(t), true, t);
  assert.equal(isSummaryQuestion("how is my card"), false);

  const { chat, last } = await setup(phonePlan);
  await chat("I got a $600 bonus, what should I do?");
  await chat("prioritize my ira over savings");
  const r = await chat("can u give me a summary of my account");
  assert.equal(r.responder, "coach");
  const text = (await last()).text;
  assert.equal(text.split("\n")[0], "Here's where you stand:");
  for (const line of [/🏦 Checking: \$1,186\.50, with \$437\.50 safe to spend until payday on Nov 20\./, /🐷 Savings: \$900\.00, about 0\.45 months of essentials\./,
    /💳 Card: \$2,400\.00 owed at 24% APR, about \$48\.00 a month in interest\./, /🚗 Car Loan: \$14,500\.00 owed, \$320\.00 a month\./,
    /🌱 IRA: \$8,200\.00, with \$150\.00 of employer match still unclaimed\./, /Your priorities: IRA first; Savings last\./, /Waiting on your YES: Move \$150\.00 from Checking to IRA\./])
    assert.match(text, line);
});

test("summary when short says so", async () => {
  const app = createApp({ secret: "", state: new StubState("shortfall") });
  const f = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  assert.match(accountSummary(await f.facts(), null, null), /🏦 Checking: \$33\.00, but short \$43\.00 on Dec 2; a \$143\.00 transfer fixes it\./);
});
