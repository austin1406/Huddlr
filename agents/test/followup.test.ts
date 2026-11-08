// Follow-up questions in a texting conversation ("where did I get 419 from?", "I thought I had 2500"):
// they go to whoever answered last, that character can show its math, and the Coach never crowns anyone in plain chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { FactsSnapshot } from "../../contracts/src";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { handleChat, isFollowUp } from "../src/chat";
import { coachProblem, keyNumbers, lowestBreakdown } from "../src/character";
import { checkMessage } from "../src/checker";
import { factsFor } from "../src/character";
import { migrate } from "../src/db";
import { financeClient } from "../src/finance";
import { parseAffordQuestion } from "../src/photo";

const facts = FactsSnapshot.parse(JSON.parse(readFileSync(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url), "utf8")));
const PHONE = "+12145550123";

test("follow-up phrasing", () => {
  for (const t of ["where did i get 419 from", "but i thought i have 2500", "how did you get that", "that's wrong", "wdym", "why?", "doesn't add up"])
    assert.equal(isFollowUp(t), true, t);
  for (const t of ["how is my card doing", "can i afford a $40 dinner", "I want to save for a car"]) assert.equal(isFollowUp(t), false, t);
});

test("Checking's lowest point is broken down in code, and every part is grounded", () => {
  const b = lowestBreakdown(facts)!;
  assert.ok(b);
  assert.equal(Math.round((b.balanceNow - b.billsTotal - b.everydaySpending) * 100) / 100, b.lowest, "the parts add up");
  assert.ok(b.billsBeforeLowest.every((x) => x.dueDate <= b.lowestDate));
  const line = keyNumbers("checking", facts, null).find((k) => k.startsWith("how your lowest point"))!;
  assert.match(line, /minus everyday spending \$[\d,.]+, leaves \$537\.50 on Nov 19/);
  assert.equal(checkMessage(line, factsFor("checking", facts, null)).ok, true, line);
});

test("the Coach can't call an account 'right' in a plain chat answer", () => {
  assert.match(coachProblem("coach", "Checking is right because your lowest balance drops.")!, /nobody argued/);
  assert.match(coachProblem("coach", "Checking is also right here.")!, /nobody argued/);
  assert.equal(coachProblem("coach", "Your lowest point is $537.50 on Nov 19."), null);
  // In a debate with no plan, an account that actually argued may still be named.
  assert.equal(coachProblem("coach", "Bottom line: Card is right.", null, null, [{ name: "Card", text: "pay me" }]), null);
  // Closing a debate with no plan: a bottom line, never a YES invite.
  assert.match(coachProblem("coach", "Card is right.", null, null, [{ name: "Card", text: "x" }])!, /Bottom line/);
  assert.match(coachProblem("coach", "Bottom line: pay it. Reply YES to approve.", null, null, [{ name: "Card", text: "x" }])!, /no plan to approve/);
});

test("'tn' and friends aren't part of the item", () => {
  assert.deepEqual(parseAffordQuestion("can i afford a $40 dinner tn"), { amount: 40, item: "dinner" });
  assert.deepEqual(parseAffordQuestion("can i buy $25 pizza rn"), { amount: 25, item: "pizza" });
});

test("after Checking answers 'can I afford', 'where did I get that from' goes back to Checking, with its math", async () => {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const now = new Date((await finance.facts()).asOf);
  const prompts: string[] = [];
  const model = async (p: string) => { prompts.push(p); return "You have $1,186.50 now."; };
  let n = 0;
  const chat = async (text: string) => {
    const id = Number((await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id", [`m${++n}`, PHONE, text, now],
    )).rows[0].id);
    await db.query("INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at) VALUES ($1, 'text', 'in', 'user', $2, $3, $4)", [PHONE, text, id, now]);
    return handleChat({ db, facts: () => finance.facts(), userPhone: PHONE, finance, model }, { id, text }, now);
  };

  assert.equal((await chat("can i afford a $40 dinner tn")).responder, "checking");
  const r = await chat("where did i get 419 from");
  assert.equal(r.responder, "checking", "not the Coach: Checking gave that number");
  const p = prompts.at(-1)!;
  assert.match(p, /how your lowest point before payday is worked out/);
  assert.match(p, /Explain plainly where its numbers come from/);
  assert.match(p, /ALL BALANCES: Checking \$1,186\.50, Savings \$900\.00, Card owed \$2,400\.00/);

  assert.equal((await chat("but i thought i have 2500")).responder, "checking", "still Checking's thread");
  assert.equal((await chat("how is my card doing")).responder, "card", "a new topic routes by topic again");
});
