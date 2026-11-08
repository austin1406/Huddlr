// Loans the user reports by text (the phone test: "i took a loan out for tuition" -> "okay now i have a loan for
// tuition for 10000 add that inn"), kept by the Loan character alongside the bank's loan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { handleChat } from "../src/chat";
import { migrate } from "../src/db";
import { financeClient } from "../src/finance";
import { loadReportedLoans, parseLoanReport, parseTerms } from "../src/loans";

const PHONE = "+12145550123";

test("spots loan reports and their numbers; questions and the bank's car loan aren't reports", () => {
  assert.deepEqual(parseLoanReport("i took a loan out for tuition"), { label: "tuition loan" });
  assert.deepEqual(parseLoanReport("okay now i have a loan for tuition for 10000 add that inn"), { label: "tuition loan", owed: 10000 });
  assert.deepEqual(parseLoanReport("I have a $10k student loan at 5%, $150 a month"), { label: "student loan", owed: 10000, aprPercent: 5, monthlyPayment: 150 });
  assert.deepEqual(parseLoanReport("add my personal loan of 3,500"), { label: "personal loan", owed: 3500 });
  for (const t of ["how is my loan doing", "@loan how am i doing", "I got a car loan", "what's a loan?"]) assert.equal(parseLoanReport(t), null, t);
  assert.deepEqual(parseTerms("5%, $150 a month"), { aprPercent: 5, monthlyPayment: 150 });
  assert.deepEqual(parseTerms("my monthly payment is 150"), { monthlyPayment: 150 });
});

async function setup() {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const now = new Date((await finance.facts()).asOf);
  const prompts: string[] = [];
  let n = 0;
  const chat = async (text: string) => {
    const id = Number((await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id", [`m${++n}`, PHONE, text, now],
    )).rows[0].id);
    await db.query("INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at) VALUES ($1, 'text', 'in', 'user', $2, $3, $4)", [PHONE, text, id, now]);
    return handleChat({ db, facts: () => finance.facts(), userPhone: PHONE, finance, model: async (p) => { prompts.push(p); return "Your loans are on track."; } }, { id, text }, now);
  };
  const last = async () => (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id DESC LIMIT 1")).rows[0];
  return { db, chat, last, prompts };
}

test("the phone test: report, amount, then rate and payment; each step is saved and answered by Loan", async () => {
  const { db, chat, last } = await setup();

  assert.equal((await chat("i took a loan out for tuition")).responder, "car_loan");
  let m = await last();
  assert.equal(m.speaker, "car_loan");
  assert.match(m.text, /^Got it, a tuition loan\. How much do you owe on it, and what's the interest rate and monthly payment\?/);
  assert.match(m.text, /It isn't in your bank data, so forecasts and plans don't count its payment yet\.$/);

  await chat("okay now i have a loan for tuition for 10000 add that inn");
  m = await last();
  assert.match(m.text, /^Updated your tuition loan: \$10,000\.00 owed\. What's the interest rate and monthly payment\?/);
  assert.match(m.text, /you owe \$24,500\.00 on loans in total/, "the bank's $14,500 loan plus the $10,000 tuition loan");

  await chat("5%, $150 a month");
  m = await last();
  assert.match(m.text, /^Updated your tuition loan: \$10,000\.00 owed at 5%, \$150\.00 a month \(about \$41\.67 interest, \$108\.33 toward what you owe\); paid off around /);
  assert.doesNotMatch(m.text, /What's/, "nothing left to ask");

  const saved = await loadReportedLoans(db, PHONE);
  assert.deepEqual(saved.map(({ label, owed, aprPercent, monthlyPayment }) => ({ label, owed, aprPercent, monthlyPayment })),
    [{ label: "tuition loan", owed: 10000, aprPercent: 5, monthlyPayment: 150 }]);
});

test("@loan afterwards knows about the tuition loan, and the summary lists it", async () => {
  const { chat, last, prompts } = await setup();
  await chat("I have a $10k student loan at 5%, $150 a month");
  await chat("@loan how am i doing");
  assert.match(prompts.at(-1)!, /OTHER LOANS THE USER TOLD YOU ABOUT \(not in the bank data\): your student loan: \$10,000\.00 owed at 5%/);
  assert.match(prompts.at(-1)!, /All loans together: \$24,500\.00 owed/);
  // The fake model never says the total, so after its retry the fallback line is used, and it still has the total.
  assert.match((await last()).text, /you owe \$24,500\.00 on loans in total/, "the total across all loans is always said");

  await chat("give me a summary of my account");
  const s = (await last()).text;
  assert.match(s, /🧾 Student loan: \$10,000\.00 owed at 5%, \$150\.00 a month .* \(you told me about this one\)\./);
  assert.match(s, /All loans together: \$24,500\.00 owed\./);
});

test("phone test: 'what do i do if i want to take out a tuition loan' never gets the loan's status line", async () => {
  // A model whose every answer is rejected (it invents a number), so the fallback is what gets sent.
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const now = new Date((await finance.facts()).asOf);
  const prompts: string[] = [];
  let n = 0;
  const chat = async (text: string, model: (p: string) => Promise<string>) => {
    const id = Number((await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id", [`m${++n}`, PHONE, text, now],
    )).rows[0].id);
    return handleChat({ db, facts: () => finance.facts(), userPhone: PHONE, finance, model }, { id, text }, now);
  };
  await chat("I have a $10k student loan at 5%, $150 a month", async () => "unused");

  const r = await chat("what do i do if i want to take out a tuition loan", async (p) => { prompts.push(p); return "Borrow $9,999.99 today."; });
  assert.equal(r.responder, "car_loan");
  assert.equal(r.source, "template");
  assert.match(r.why ?? "", /9,999\.99/, "the log says why the fallback was used");
  const sent = (await db.query<{ text: string }>("SELECT text FROM outbox ORDER BY id DESC LIMIT 1")).rows[0].text;
  assert.match(sent, /^Before you sign, check three things: how much you'd borrow, the interest rate, and the monthly payment\. Then make sure that payment fits: Right now you have \$437\.50 safe to spend until payday on Nov 20, and your current loan already takes \$320\.00 a month\. Text me the amount, rate and payment and I'll break it down\.$/);
  assert.doesNotMatch(sent, /left at 6\.9%|paid off around/, "not the loan's status line");
  assert.doesNotMatch(prompts[0], /Include \$24,500\.00/, "the all-loans total isn't required for this question");
});
