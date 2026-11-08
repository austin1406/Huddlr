import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { FactsSnapshot, Plan } from "../../contracts/src";
import { handleChat } from "../src/chat";
import { migrate } from "../src/db";
import { makeProposalService } from "../src/proposals";
import { isRecallQuestion, recallAnswer } from "../src/recall";
import { handleInbound } from "../src/replies";

const load = (rel: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${rel}`, import.meta.url), "utf8"));
const facts = FactsSnapshot.parse(load("facts.shortfall.fixture.json"));
const plan = Plan.parse(load("plan.fixture.json"));
const PHONE = "+15555550100";
const now = new Date("2026-12-02T16:00:00.000Z");

test("recognizes 'what did we decide' questions", () => {
  for (const t of ["what did we decide?", "What was the plan", "remind me what we said", "recap pls", "what's the plan?"]) assert.equal(isRecallQuestion(t), true, t);
  for (const t of ["yes", "how is my card", "decide for me"]) assert.equal(isRecallQuestion(t), false, t);
});

test("answers from the last call summary and the latest plan, even while a plan is pending", async () => {
  const db = new PGlite();
  await migrate(db);
  const proposals = makeProposalService(db, () => now);
  await proposals.create({ userPhone: PHONE, plan, from: "savings", to: "checking", amount: 143, actionText: "Move $143.00 from Savings to Checking" });
  await db.query(
    `INSERT INTO calls (user_phone, provider_call_id, direction, summary, decisions, ended_sim_at)
     VALUES ($1, 'el-1', 'outbound', 'You agreed to cover rent week by moving $143 from Savings', '[]', $2)`,
    [PHONE, new Date("2026-12-02T15:30:00.000Z")],
  );
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('r1', $1, 'what did we decide?', $2)", [PHONE, now]);

  const r = await handleInbound(db, proposals, { id: 1, user_phone: PHONE, text: "what did we decide?" }, now);
  assert.equal(r.kind, "chat", "not treated as an unclear YES");
  await handleChat({ db, facts: async () => facts, userPhone: PHONE }, { id: 1, text: "what did we decide?" }, now);
  const out = (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox")).rows;
  assert.equal(out.length, 1);
  assert.equal(out[0].speaker, "coach");
  assert.match(out[0].text, /On our last call \(Dec 2\): You agreed to cover rent week/);
  assert.match(out[0].text, /Latest plan: Move \$143\.00 from Savings to Checking\. Status: still waiting on your YES/);
});

test("nothing on record gets an honest answer", async () => {
  const db = new PGlite();
  await migrate(db);
  assert.equal(await recallAnswer(db, PHONE, "America/Chicago"), null);
});
