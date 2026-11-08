// Phone testing: "18000 for 24 months" after Loan asked about the tuition loan went to the Coach alone; and general
// questions should get every account's say before the Coach's bottom line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { handleChat } from "../src/chat";
import { migrate } from "../src/db";
import { accountsInQuestion, runRoundtable } from "../src/debate";
import { financeClient } from "../src/finance";
import { loadReportedLoans, parseLoanNumbers, paymentFor } from "../src/loans";
import { makeProposalService } from "../src/proposals";

const PHONE = "+12145550123";

async function setup(model: (p: string) => Promise<string>) {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const now = new Date((await finance.facts()).asOf);
  const proposals = makeProposalService(db, () => now);
  let n = 0;
  const chat = async (text: string) => {
    const id = Number((await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id", [`m${++n}`, PHONE, text, now],
    )).rows[0].id);
    await db.query("INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at) VALUES ($1, 'text', 'in', 'user', $2, $3, $4)", [PHONE, text, id, now]);
    return handleChat({
      db, facts: () => finance.facts(), userPhone: PHONE, finance, proposals, model,
      roundtable: (ask, t) => runRoundtable({ db, finance, proposals, userPhone: PHONE, model }, ask, t),
    }, { id, text }, now);
  };
  const out = async () => (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id")).rows;
  return { db, chat, out };
}

test("loan lengths are read, and amount + rate + length gives the monthly payment", () => {
  assert.deepEqual(parseLoanNumbers("18000 for 24. months"), { owed: 18000, termMonths: 24 });
  assert.deepEqual(parseLoanNumbers("$10k at 5% over 4 years"), { owed: 10000, aprPercent: 5, termMonths: 48 });
  assert.equal(paymentFor(18000, 6, 24), 797.77);
  assert.equal(paymentFor(1200, 0, 12), 100);
});

test("phone test: after Loan asks, '18000 for 24. months' fills in the tuition loan; then the rate finishes it", async () => {
  const { db, chat, out } = await setup(async () => "unused");
  await chat("i took a loan out for tuition");
  const r = await chat("18000 for 24. months");
  assert.equal(r.responder, "car_loan", "not the Coach alone");
  let last = (await out()).at(-1)!;
  assert.match(last.text, /^Updated your tuition loan: \$18,000\.00 owed over 24 months\. What's the interest rate\?/);

  await chat("6%");
  last = (await out()).at(-1)!;
  assert.match(last.text, /^Updated your tuition loan: \$18,000\.00 owed at 6%, \$797\.77 a month \(about \$90\.00 interest, \$707\.77 toward what you owe\); paid off around /);
  const [loan] = await loadReportedLoans(db, PHONE);
  assert.equal(loan.monthlyPayment, 797.77, "worked out from the amount, rate and length");
});

test("a general question: the accounts it touches weigh in, then the Coach's bottom line answers it", async () => {
  assert.deepEqual(accountsInQuestion("should I pay off my card or build savings first?"), ["card", "savings"]);
  const prompts: string[] = [];
  const { chat, out } = await setup(async (p) => {
    prompts.push(p);
    if (p.startsWith("You are Coach")) return "Bottom line: pay down the card first, since its $48.00 monthly interest costs more than savings earns.";
    if (p.startsWith("You are Card")) return "Your card costs $48.00 a month in interest.";
    if (p.startsWith("You are Savings")) return "Your $900.00 covers about 2 weeks of must-pay bills.";
    return "You have $437.50 safe to spend until payday.";
  });
  const r = await chat("should I pay off my card or build savings first?");
  assert.equal(r.responder, "coach");
  assert.deepEqual(r.debate, ["card", "savings", "ira", "coach"], "the accounts it names first, then the one with something pressing");
  const rows = await out();
  assert.deepEqual(rows.map((x) => x.speaker), ["coach", "card", "savings", "ira", "coach"]);
  assert.equal(rows[0].text, "Good question. Card, Savings and IRA weigh in, then my bottom line.");
  assert.match(rows.at(-1)!.text, /^Bottom line: pay down the card first/);
  assert.match(prompts.find((p) => p.startsWith("You are Coach"))!, /Start with "Bottom line:" and answer the user's question directly/);
});

test("@coach still gets one voice", async () => {
  const { chat, out } = await setup(async () => "You're on track this month.");
  const r = await chat("@coach how am I doing?");
  assert.equal(r.debate, undefined);
  assert.deepEqual((await out()).map((x) => x.speaker), ["coach"]);
});

test("phone test: two things in one text get both answered, and thinking about a loan isn't saving one", async () => {
  const { parseLoanReport } = await import("../src/loans");
  assert.equal(parseLoanReport("i wanna purchase something for $20 and take a loan out"), null);
  assert.equal(parseLoanReport("wait can i purchase a dinner tn and then take a loan out from the bank for a new house"), null);

  const prompts: string[] = [];
  const { db, chat, out } = await setup(async (p) => {
    prompts.push(p);
    if (p.startsWith("You are Coach")) return "Bottom line: the $20.00 purchase fits, and before a loan check the rate and monthly payment.";
    if (p.startsWith("You are Loan")) return "Before a new loan, check the rate and the monthly payment against your $437.50 safe to spend.";
    return "Yes, $20.00 fits; you have $437.50 safe to spend until payday.";
  });
  const r = await chat("i wanna purchase something for $20 and take a loan out");
  assert.ok(r.debate?.includes("checking") && r.debate?.includes("car_loan"), `both parts answered: ${r.debate}`);
  assert.equal(r.debate?.at(-1), "coach");
  const coachPrompt = prompts.find((p) => p.startsWith("You are Coach"))!;
  assert.match(coachPrompt, /CAN THEY AFFORD THE PURCHASE \(from the finance engine; Checking should say this\): Yes, \$20\.00 fits/);
  assert.match(coachPrompt, /THEY'RE ALSO THINKING ABOUT A NEW LOAN/);
  assert.match(coachPrompt, /each of you answers the part about your account/);
  const saved = await db.query("SELECT 1 FROM memory_facts WHERE key LIKE 'loan:%'");
  assert.equal(saved.rows.length, 0, "no 'other loan' saved");
  assert.ok((await out()).every((m) => !/other loan/.test(m.text)));
});

test("phone test: 'check with @loan if i can get a house' and 'so can i take out a loan for a house' answer the house question", async () => {
  const { parseMention } = await import("../src/chat");
  const { isHomeQuestion, homeLoanCheck } = await import("../src/loans");
  assert.deepEqual(parseMention("can i check with @loan if i can get a house"), { who: "car_loan", rest: "can i check with loan if i can get a house" });
  assert.equal(parseMention("email me at a@card.com"), null, "an email address isn't a mention");
  for (const t of ["so can i take out a loan for a house", "can i get a house", "am i ready for a mortgage?"]) assert.equal(isHomeQuestion(t), true, t);
  assert.equal(isHomeQuestion("i'm home"), false);

  const prompts: string[] = [];
  const { chat, out } = await setup(async (p) => {
    prompts.push(p);
    if (p.startsWith("You are Coach")) return "Bottom line: build your savings for a down payment first.";
    return "Your debt payments are $392.00 a month, about 11% of income.";
  });

  // With @loan: Loan alone, answering the house question with the lender's-eye numbers.
  let r = await chat("can i check with @loan if i can get a house");
  assert.equal(r.responder, "car_loan");
  assert.equal(r.debate, undefined);
  assert.match(prompts.at(-1)!, /They're asking whether they can take out a home loan/);
  assert.match(prompts.at(-1)!, /HOME LOAN CHECK .*income about \$3,584\.82 a month \(\$1,650\.00 paychecks every 14 days\); debt payments already \$392\.00 a month \(loan payment \$320\.00, card minimum \$72\.00\), about 11% of income\. That's UNDER the 36% guideline, which is a plus/);
  assert.match(prompts.at(-1)!, /Savings for a down payment: \$900\.00, which is small/);
  assert.match(prompts.at(-1)!, /Card use over 30% of the limit can lower a credit score/, "48% of the limit is over the 30% guideline");
  assert.doesNotMatch(prompts.at(-1)!, /Include \$/, "no all-loans-total requirement for this question");

  // No @: the whole table, each on their part of a home loan, then the Coach.
  r = await chat("so can i take out a loan for a house");
  assert.ok(r.debate && r.debate.length >= 3 && r.debate.at(-1) === "coach", `roundtable: ${r.debate}`);
  assert.match(prompts.find((p, i) => i > 0 && p.startsWith("You are Coach"))!, /THEY'RE ASKING IF THEY CAN TAKE OUT A HOME LOAN/);
  assert.equal((await out()).at(-1)!.text, "Bottom line: build your savings for a down payment first.");

  const h = homeLoanCheck(await (await import("../src/finance")).financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) =>
    createApp({ secret: "", state: new StubState("normal") }).request(u.replace("http://f", ""), i)) as typeof fetch).facts(), []);
  assert.equal(h.debtSharePercent, 11);
});
