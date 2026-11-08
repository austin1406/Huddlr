// "I got a $600 bonus, what should I do?" by text -> a group debate and a plan to say YES to.
// Also: re-queuing an existing outbox key must not burn ids (the digest poller does this every few seconds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createApp as createFinanceApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { handleChat, parseWindfall } from "../src/chat";
import { checkMessage } from "../src/checker";
import { factsFor } from "../src/character";
import { migrate } from "../src/db";
import { proposalFromPlan, runWindfall } from "../src/debate";
import { financeClient } from "../src/finance";
import { queueOutbox } from "../src/outbox";
import { makeProposalService } from "../src/proposals";

const PHONE = "+12145550123";
/** Invents a number in every reply, so everything sent must come out of the checker grounded. */
const liar = async () => "Only $9,999.99 left, trust me!";

async function setup() {
  const db = new PGlite();
  await migrate(db);
  const app = createFinanceApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const facts = await finance.facts();
  const now = new Date(facts.asOf);
  const proposals = makeProposalService(db, () => now);
  let n = 0;
  const inbound = async (text: string) => {
    const r = await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`m${++n}`, PHONE, text, now],
    );
    return Number(r.rows[0].id);
  };
  const chat = async (text: string) => {
    const id = await inbound(text);
    return handleChat(
      { db, facts: () => finance.facts(), userPhone: PHONE, finance, model: liar,
        windfall: (ask, t) => runWindfall({ db, finance, proposals, userPhone: PHONE, model: liar }, ask, t) },
      { id, text },
      now,
    );
  };
  const outbox = async () =>
    (await db.query<{ speaker: string; text: string; priority: number; reply_to: number | null; proposal_id: number | null }>(
      "SELECT speaker, text, priority, reply_to, proposal_id FROM outbox ORDER BY id",
    )).rows;
  return { db, finance, facts, proposals, chat, outbox, now };
}

test("spots windfall questions with one amount", () => {
  assert.deepEqual(parseWindfall("I got a $600 bonus, what should I do?"), { amount: 600, label: "the user got a bonus" });
  assert.deepEqual(parseWindfall("tax refund came in, $1,200"), { amount: 1200, label: "the user got a tax refund" });
  assert.deepEqual(parseWindfall("got an inheritance of $5k"), { amount: 5000, label: "the user got an inheritance" });
  assert.deepEqual(parseWindfall("I have an extra $300, what should I do with it?"), { amount: 300, label: "the user has extra money" });
  assert.equal(parseWindfall("can I afford a $40 dinner?"), null, "affordability is its own path");
  assert.equal(parseWindfall("what should I do?"), null, "no amount");
  assert.equal(parseWindfall("got a $600 bonus and a $200 refund"), null, "two amounts is ambiguous");
  assert.equal(parseWindfall("how is my card"), null);
});

test("'$600 bonus, what should I do?' -> two accounts debate, the Coach closes with a plan to say YES to", async () => {
  const { chat, outbox, proposals, finance, facts, db } = await setup();
  const r = await chat("I got a $600 bonus, what should I do?");
  assert.equal(r.debate?.length, 3, `speakers: ${r.debate}`);

  const sent = await outbox();
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1)!.speaker, "coach", "Coach goes last");
  assert.notEqual(sent[0].speaker, sent[1].speaker);
  assert.ok(sent.every((m) => m.priority === 1 && m.reply_to != null), "a reply to the user's text, not proactive");

  // The account P1's plan favors is one of the speakers, so the Coach can side with someone who actually spoke.
  const plan = await finance.plan(600);
  const ask = proposalFromPlan(plan)!;
  assert.ok(sent.slice(0, 2).some((m) => m.speaker === String(plan.lines[0].destination)), `plan favors ${plan.lines[0].destination}`);
  assert.match(sent.at(-1)!.text, new RegExp(`Reply YES to: ${ask.actionText.replace(/\$/g, "\\$").replace(/\./g, "\\.")}`));

  const pending = await proposals.getPending(PHONE);
  assert.equal(pending?.amount, ask.amount);
  assert.equal(sent.at(-1)!.proposal_id, Number(pending!.id));

  // Grounded: the liar model's $9,999.99 never gets out; $600 (the user's own number) may be repeated.
  for (const m of sent) {
    assert.doesNotMatch(m.text, /9,999/);
    assert.equal(checkMessage(m.text, factsFor(m.speaker as never, facts), plan, [600]).ok, true, m.text);
  }
  // Not an emergency: a reminder later, never a phone call.
  const f = await db.query<{ kind: string }>("SELECT kind FROM follow_ups");
  assert.deepEqual(f.rows.map((x) => x.kind), ["proposal_reminder"]);
});

test("a second windfall replaces the waiting plan, so YES approves what the latest message asked", async () => {
  const { chat, outbox, proposals } = await setup();
  await chat("I got a $600 bonus, what should I do?");
  const first = await proposals.getPending(PHONE);
  await chat("also got a $200 refund, what should I do?");
  const last = (await outbox()).at(-1)!;
  const second = await proposals.getPending(PHONE);
  assert.notEqual(second?.id, first?.id);
  assert.equal(second?.amount, 200);
  assert.equal(last.proposal_id, Number(second!.id));
  assert.match(last.text, new RegExp(`Reply YES to: ${second!.actionText.replace(/\$/g, "\\$").replace(/\./g, "\\.")}`));
  assert.equal((await proposals.get(Number(first!.id)))?.status, "expired", "the old plan can no longer be approved");
});

test("@savings with a bonus question gets one voice, not the whole crew", async () => {
  const { chat, outbox } = await setup();
  const r = await chat("@savings I got a $600 bonus, what should I do?");
  assert.equal(r.debate, undefined);
  assert.equal(r.responder, "savings");
  assert.equal((await outbox()).length, 1);
});

test("re-queuing an existing outbox key does not burn ids", async () => {
  const { db, now } = await setup();
  const row = (key: string) => ({ idempotency_key: key, user_phone: PHONE, speaker: "coach" as const, text: "hi", priority: 0 as const, created_sim_at: now.toISOString() });
  const a = await queueOutbox(db, row("digest:a"));
  for (let i = 0; i < 5; i++) assert.equal(await queueOutbox(db, row("digest:a")), null);
  const b = await queueOutbox(db, row("digest:b"));
  assert.equal(b, a! + 1, "no gap after five duplicate attempts");
});
