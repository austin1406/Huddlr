// Group-chat feel from product testing: explain (don't persuade), calm tone, characters answering each other with
// iMessage threading (outbox.reply_to_outbox), the Coach's opening signpost, and the first-text welcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { cardMonthlyInterest, cast, styleProblem, template } from "../src/character";
import { migrate } from "../src/db";
import { answering, runWindfall } from "../src/debate";
import { financeClient } from "../src/finance";
import { makeProposalService } from "../src/proposals";
import { maybeWelcome, welcomeText } from "../src/welcome";

const PHONE = "+12145550123";

test("style: accounts explain instead of asking for the money; nobody sounds nervous or uses slang", () => {
  for (const bad of ["Put the entire $600.00 here where it belongs.", "Send that bonus straight to me.", "Pay me first.", "Toss it my way.", "Every dollar belongs down here with me."])
    assert.match(styleProblem("savings", bad)!, /instead of asking for the money/, bad);
  assert.match(styleProblem("checking", "I'm nervous about Dec 2.")!, /calm/);
  assert.match(styleProblem("coach", "Be careful with spending this week.")!, /calm/);
  assert.match(styleProblem("card", "ngl that APR is rough.")!, /slang/);
  for (const ok of ["Paying $457.00 toward the card saves you $9.14 a month in interest.", "Agreed with IRA on this one.", "That covers 0.45 months of essentials."])
    assert.equal(styleProblem("card", ok), null, ok);
});

test("a reply that opens by naming an earlier speaker threads under that message", () => {
  const posted = [{ name: "IRA", outboxId: 11 }, { name: "Card", outboxId: 12 }];
  assert.equal(answering("Agreed with IRA on this one. The match is free money.", posted), 11);
  assert.equal(answering("Adding to Card: the $72.00 minimum is due Dec 28.", posted), 12);
  assert.equal(answering("Your card balance is $2,400.00.", posted), null, "lowercase 'card' isn't a reply to Card");
  assert.equal(answering("You have $900.00 saved. Card has a point about interest.", posted), null, "only the first sentence counts");
});

test("bonus debate: Coach signpost first, accounts in turn, a reply threads under the message it answers", async () => {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("shortfall") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const now = new Date((await finance.facts()).asOf);
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'x', $2)", [PHONE, now]);
  const prompts: string[] = [];
  // Card speaks first; Checking answers it by name.
  const model = async (p: string) => {
    prompts.push(p);
    if (p.startsWith("You are Card")) return "You owe $2,400.00 at 24% APR. Sending $457.00 there saves you $9.14 a month in interest.";
    if (p.startsWith("You are Checking")) return "Adding to Card: keeping $143.00 here covers the $43.00 gap on Dec 2.";
    return "Bottom line: keep $143.00 in Checking for the gap and send $457.00 to Card for the interest. Move $457.00 from Checking to Card in your bank app.";
  };
  await runWindfall({ db, finance, proposals: makeProposalService(db, () => now), userPhone: PHONE, model }, { inboundId: 1, text: "I got a $600 bonus", amount: 600, label: "the user got a bonus" }, now);

  const rows = (await db.query<{ id: number; speaker: string; text: string; reply_to: number | null; reply_to_outbox: number | null }>(
    "SELECT id, speaker, text, reply_to, reply_to_outbox FROM outbox ORDER BY id",
  )).rows.map((r) => ({ ...r, id: Number(r.id), reply_to_outbox: r.reply_to_outbox == null ? null : Number(r.reply_to_outbox) }));
  assert.deepEqual(rows.map((r) => r.speaker), ["coach", "card", "checking", "savings", "coach"], "every account with a stake gives its option");
  assert.equal(rows[0].text, "Good question. Card, Checking and Savings weigh in, then my plan.");
  assert.equal(Number(rows[0].reply_to), 1, "the signpost replies to the user's question");
  assert.equal(rows[2].reply_to_outbox, rows[1].id, "Checking's reply threads under Card's message");
  assert.equal(rows[1].reply_to_outbox, null);

  // Checking heard Card before speaking, and was told it may answer by name.
  const checkingPrompt = prompts.find((p) => p.startsWith("You are Checking"))!;
  assert.match(checkingPrompt, /WHAT THE OTHERS JUST SAID:\n- Card: You owe \$2,400\.00/);
  assert.match(checkingPrompt, /If you genuinely agree with or build on what one of the others said, you may open by saying so by name/);
  // Card was told what the plan means for the user on its side, with the plan's own numbers.
  assert.match(prompts.find((p) => p.startsWith("You are Card"))!, /The plan sends \$457\.00 to Card, which saves \$9\.14 a month in interest/);
});

test("Card can say what the balance costs each month (computed in code)", async () => {
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const facts = await finance.facts();
  assert.equal(cardMonthlyInterest(facts), 48, "$2,400 at 24% APR is $48.00 a month");
  const t = template("card", facts);
  assert.match(t, /costs about \$48\.00 a month in interest/);
  for (const c of cast) assert.equal(styleProblem(c.id, template(c.id, facts)), null, `${c.id} template: ${template(c.id, facts)}`);
});

test("welcome: the Coach introduces the crew on a phone's first text, once", async () => {
  const db = new PGlite();
  await migrate(db);
  const now = new Date("2026-11-07T16:00:00.000Z");
  const insert = async (phone: string, key: string) =>
    Number((await db.query<{ id: number }>("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, 'hi', $3) RETURNING id", [key, phone, now])).rows[0].id);

  const first = await insert(PHONE, "a");
  assert.equal(await maybeWelcome(db, { id: first, user_phone: PHONE }, now), true);
  const second = await insert(PHONE, "b");
  assert.equal(await maybeWelcome(db, { id: second, user_phone: PHONE }, now), false, "only the first text");
  assert.equal(await maybeWelcome(db, { id: first, user_phone: PHONE }, now), false, "never twice");

  const out = await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox");
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].speaker, "coach");
  assert.equal(out.rows[0].text, welcomeText());
  assert.match(welcomeText(), /^Meet your money: 🏦 Checking, 🐷 Savings, 💳 Card, 🧾 Loan and 🌱 IRA each watch one account\. 🧭 Coach always gives the final plan\. Ask anything, or @mention one of them \(like @Savings\)\.$/);
});

test("an option with a false 'Adding to X:' lead-in loses it and isn't threaded under X", async () => {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const now = new Date((await finance.facts()).asOf);
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'x', $2)", [PHONE, now]);
  const { runOptions } = await import("../src/debate");
  const model = async (p: string) => p.startsWith("You are Card") ? "Option: put $2,400.00 toward the card; that saves $48.00 a month." : "Adding to Card: Option: claim the $150.00 employer match.";
  await runOptions({ db, finance, proposals: makeProposalService(db, () => now), userPhone: PHONE, model }, { inboundId: 1, text: "so what should i do", waiting: null }, now);
  const ira = (await db.query<{ text: string; reply_to_outbox: number | null }>("SELECT text, reply_to_outbox FROM outbox WHERE speaker = 'ira'")).rows[0];
  assert.equal(ira.text, "Option: claim the $150.00 employer match.");
  assert.equal(ira.reply_to_outbox, null);
});

test("a reply cut off mid-sentence is never sent as is", () => {
  assert.match(styleProblem("car_loan", "Paying an extra $100.00 a month would")!, /cut off/);
  for (const ok of ["That saves $9.14 a month.", "Paid off around Apr 2031!", "Want the breakdown?", 'Say "your loan."'])
    assert.equal(styleProblem("car_loan", ok), null, ok);
});
