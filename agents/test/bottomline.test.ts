// Product testing: "I don't understand what to do. There's information but I don't know the bottom line."
// Every group reply ends with the Coach's bottom line, and "so what should I do" always gets one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { FinanceEvent, Plan } from "../../contracts/src";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { bottomLine } from "../src/bottomline";
import { planTemplate } from "../src/character";
import { handleChat } from "../src/chat";
import { migrate } from "../src/db";
import { runEvent, type DebateDeps } from "../src/debate";
import { financeClient } from "../src/finance";
import { pickSpeakers } from "../src/moderator";
import { makeProposalService } from "../src/proposals";
import { handleInbound, isBottomLineQuestion } from "../src/replies";

const PHONE = "+12145550123";
// The plan from the screenshot: paycheck -> $150 IRA (match), $1,161.50 card.
const paycheckPlan: Plan = {
  schemaVersion: 1, asOf: "2026-11-07T16:00:00.000Z", amount: 1311.5, shortfallCovered: 0, unallocated: 0,
  lines: [
    { destination: "ira", amount: 150, reasonCode: "capture_employer_match", reasonNumbers: { unclaimedMatchThisYear: 150 } },
    { destination: "card", amount: 1161.5, reasonCode: "pay_high_interest_debt", reasonNumbers: { aprPercent: 24, monthlyInterestSaved: 23.23 } },
  ],
};

async function finance(scenario: "normal" | "shortfall" = "normal") {
  const app = createApp({ secret: "", state: new StubState(scenario) });
  return financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
}

test("'so what should i do' and friends ask for the bottom line", () => {
  for (const t of ["so what should i do", "what should I do", "ok so what now", "now what", "what's the bottom line", "tldr", "i don't know what to do", "which one should i pick"])
    assert.equal(isBottomLineQuestion(t), true, t);
  for (const t of ["yes", "maybe", "how is my card", "so what about savings"]) assert.equal(isBottomLineQuestion(t), false, t);
});

test("bottom line with a plan waiting: the one action, why, and the rest as optional", async () => {
  const facts = await (await finance()).facts();
  const text = bottomLine(facts, { actionText: "Move $150.00 from Checking to IRA", to: "ira", plan: paycheckPlan, windfall: false });
  assert.equal(text,
    "Bottom line: move $150.00 from Checking to IRA in your bank app. That grabs your employer match: free money your job adds when you put money in. " +
    "The plan also suggests $1,161.50 to your card whenever you're ready. I'll check it off when I see the transfer.");
});

test("bottom line with nothing waiting: says whether anything needs doing", async () => {
  assert.match(bottomLine(await (await finance()).facts(), null), /^Bottom line: nothing needs your OK right now\. You have \$437\.50 safe to spend until payday on Nov 20\.$/);
  assert.match(bottomLine(await (await finance("shortfall")).facts(), null), /^Bottom line: you'd be short \$43\.00 on Dec 2\. Moving \$143\.00 from Savings to Checking in your bank app fixes it/);
});

test("the screenshot: 'so what should i do' with a plan waiting gets the bottom line, not 'only a clear YES'", async () => {
  const db = new PGlite();
  await migrate(db);
  const f = await finance();
  const now = new Date((await f.facts()).asOf);
  const proposals = makeProposalService(db, () => now);
  await proposals.create({ userPhone: PHONE, plan: paycheckPlan, from: "checking", to: "ira", amount: 150, actionText: "Move $150.00 from Checking to IRA", sourceEventId: "evt_paycheck_landed_x" });
  const id = Number((await db.query<{ id: number }>("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'so what should i do', $2) RETURNING id", [PHONE, now])).rows[0].id);
  const row = { id, user_phone: PHONE, text: "so what should i do" };
  assert.equal((await handleInbound(db, proposals, row, now)).kind, "chat", "not the clarify nudge");
  const r = await handleChat({ db, facts: () => f.facts(), userPhone: PHONE, finance: f, proposals, model: async () => "unused" }, row, now);
  assert.equal(r.responder, "coach");
  const out = (await db.query<{ text: string }>("SELECT text FROM outbox ORDER BY id DESC LIMIT 1")).rows[0].text;
  assert.match(out, /^Bottom line: move \$150\.00 from Checking to IRA in your bank app\./);
  assert.doesNotMatch(out, /reply yes/i, "the Coach can't move money, so it never asks for a YES");
  assert.equal((await proposals.getPending(PHONE))?.status, "pending", "answering never approves");
});

test("every debate ends with the Coach, plan or not", () => {
  const ev = (type: FinanceEvent["type"], accountId: FinanceEvent["accountId"] = "checking"): FinanceEvent =>
    ({ id: `e_${type}`, type, occurredAt: "2026-11-07T16:00:00.000Z", severity: "medium", accountId, data: {} });
  for (const type of ["bill_due_soon", "big_purchase", "paycheck_landed", "forecast_problem"] as const) {
    const s = pickSpeakers(ev(type));
    assert.equal(s.at(-1), "coach", type);
    assert.ok(s.length <= 4, `${type}: up to 3 accounts plus the Coach`);
  }
});

test("bill due soon (no plan): accounts explain, the Coach closes with a bottom line and no YES", async () => {
  const db = new PGlite();
  await migrate(db);
  const f = await finance();
  const facts = await f.facts();
  const t = new Date(facts.asOf);
  const prompts: string[] = [];
  const model = async (p: string) => {
    prompts.push(p);
    return p.startsWith("You are Coach") ? "Bottom line: nothing to do now; your $1,186.50 covers the Phone bill." : "Your balance is $1,186.50.";
  };
  const deps: DebateDeps = { db, finance: f, proposals: makeProposalService(db, () => t), userPhone: PHONE, clock: async () => ({ now: t, demoMode: true }), model };
  await runEvent(deps, { id: "evt_bill_due_soon_phone", type: "bill_due_soon", occurredAt: facts.asOf, severity: "medium", accountId: "checking", data: { billId: "phone", amount: 65, dueDate: "2026-11-12", daysUntil: 3 } });
  const rows = (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id")).rows;
  assert.equal(rows.at(-1)!.speaker, "coach");
  assert.match(rows.at(-1)!.text, /^Bottom line:/);
  assert.doesNotMatch(rows.at(-1)!.text, /reply yes/i);
  assert.match(prompts.find((p) => p.startsWith("You are Coach"))!, /There's no plan to approve\. Give the bottom line/);
});

test("the Coach's pre-written plan line leads with the bottom line too", () => {
  const t = planTemplate(paycheckPlan, "Move $150.00 from Checking to IRA");
  assert.match(t, /^Bottom line: \$150\.00 to IRA to grab the free employer match\. The plan also suggests \$1,161\.50 to Card for later\. Move \$150\.00 from Checking to IRA in your bank app\.$/);
});

test("'so what should i do' with the roundtable: every account in the plan gives its option, then the Coach's bottom line", async () => {
  const { runOptions } = await import("../src/debate");
  const db = new PGlite();
  await migrate(db);
  const f = await finance();
  const now = new Date((await f.facts()).asOf);
  const proposals = makeProposalService(db, () => now);
  await proposals.create({ userPhone: PHONE, plan: paycheckPlan, from: "checking", to: "ira", amount: 150, actionText: "Move $150.00 from Checking to IRA", sourceEventId: "evt_paycheck_landed_x" });
  const id = Number((await db.query<{ id: number }>("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'so what should i do', $2) RETURNING id", [PHONE, now])).rows[0].id);
  const prompts: string[] = [];
  const model = async (p: string) => { prompts.push(p); return p.startsWith("You are IRA") ? "Option: put $150.00 into the IRA; that claims the full match." : "Option: put $1,161.50 toward the card; that saves $23.23 a month."; };
  const r = await handleChat({
    db, facts: () => f.facts(), userPhone: PHONE, finance: f, proposals, model,
    options: (ask, t) => runOptions({ db, finance: f, proposals, userPhone: PHONE, model }, ask, t),
  }, { id, text: "so what should i do" }, now);
  assert.deepEqual(r.debate, ["ira", "card", "savings", "coach"], "the plan's accounts first, then others with a stake");
  const rows = (await db.query<{ speaker: string; text: string; reply_to: number | null }>("SELECT speaker, text, reply_to FROM outbox ORDER BY id")).rows;
  assert.deepEqual(rows.map((x) => x.speaker), ["coach", "ira", "card", "savings", "coach"]);
  assert.equal(rows[0].text, "Good question. IRA, Card and Savings each give an option, then my bottom line.");
  assert.match(rows[1].text, /^Option: put \$150\.00 into the IRA/);
  assert.match(rows.at(-1)!.text, /^Bottom line: move \$150\.00 from Checking to IRA in your bank app\./);
  assert.ok(rows.every((x) => Number(x.reply_to) === id), "all threaded under the question");
  assert.match(prompts[0], /The plan sends \$150\.00 to IRA/);
  assert.match(prompts[0], /Give the user your option/);
  assert.equal((await proposals.getPending(PHONE))?.status, "pending", "options never approve anything");
});
