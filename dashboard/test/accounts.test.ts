import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { ACCOUNT_TYPES, addAccount, countAdded, loadUserAccounts, parseAccount, removeAccount, updateAccount } from "../src/accounts.js";
import { buildHuddle } from "../src/huddle.js";
import { loadReportedLoans, type Db } from "../src/state.js";

const PHONE = "+15550001111";
const facts = () => JSON.parse(readFileSync(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url), "utf8"));
const cast = JSON.parse(readFileSync(new URL("../../contracts/cast.json", import.meta.url), "utf8")).characters;
async function db(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../contracts/p2_agents.sql", import.meta.url), "utf8"));
  return pg as unknown as Db;
}

test("every type goes to an existing agent by what the money is for", () => {
  const owner = (t: string) => ACCOUNT_TYPES[t].owner;
  assert.equal(owner("cd"), "savings");
  assert.equal(owner("hsa"), "savings");
  assert.equal(owner("mortgage"), "car_loan");
  assert.equal(owner("brokerage"), "ira");
  assert.equal(owner("credit_card"), "card");
  assert.equal(owner("cash_app"), "checking");
  for (const [id, t] of Object.entries(ACCOUNT_TYPES)) assert.ok(cast.some((c: any) => c.id === t.owner), id);
  assert.equal(ACCOUNT_TYPES.credit_card.joinsLoan, undefined); // a card gets its own seat
  assert.equal(ACCOUNT_TYPES.student_loan.joinsLoan, true);
});

test("the form is checked in plain words", () => {
  assert.deepEqual(parseAccount({ type: "nope", balance: 1 }), { error: "Pick what kind of account this is." });
  assert.deepEqual(parseAccount({ type: "mortgage", balance: "" }), { error: "Enter how much you owe." });
  assert.deepEqual(parseAccount({ type: "cd", balance: "5,000", aprPercent: "4.5%", until: "2027-06-01", name: "<b>My CD</b>" }), {
    type: "cd", name: "bMy CD/b", balance: 5000, aprPercent: 4.5, until: "2027-06-01",
  });
  assert.deepEqual(parseAccount({ type: "hsa", balance: 10 }), { type: "hsa", name: "HSA (health savings)", balance: 10 });
});

test("a CD gets its own seat; a student loan joins the Loan total; both reach the agents' tables", async () => {
  const d = await db();
  const cdKey = await addAccount(d, PHONE, { type: "cd", name: "Emergency CD", balance: 5000, aprPercent: 4.5, until: "2027-06-01" });
  const loanKey = await addAccount(d, PHONE, { type: "student_loan", name: "Tuition", balance: 10000, aprPercent: 5 });
  assert.match(cdKey, /^account:cd_[0-9a-f]{6}$/);
  assert.equal(loanKey, "loan:tuition");
  assert.equal(await countAdded(d, PHONE), 2);

  const accounts = await loadUserAccounts(d, PHONE);
  const loans = await loadReportedLoans(d, PHONE);
  assert.equal(loans[0].owed, 10000); // the shape P2's Loan agent already reads
  const h = buildHuddle(facts(), cast, { reportedLoans: loans, userAccounts: accounts });
  const cd = h.people.find((p) => p.id === cdKey)!;
  assert.equal(cd.group, "have");
  assert.match(cd.says, /\$5,000 at 4\.5%, locked until Jun 1/);
  assert.ok(cd.detail.some((r) => r.label === "In the chat" && r.value.includes("Savings")));
  assert.equal(h.people.find((p) => p.id === "car_loan")!.balance, 14500 + 10000);
  assert.equal(h.have, 1186.5 + 900 + 8200 + 5000);
  assert.equal(h.coach.counts.good + h.coach.counts.watch + h.coach.counts.concern, 5); // added accounts aren't scored
});

test("edit keeps the account; remove takes it away; a loan can't become a seat", async () => {
  const d = await db();
  const key = await addAccount(d, PHONE, { type: "credit_card", name: "Store card", balance: 300 });
  assert.equal(await updateAccount(d, PHONE, key, { type: "credit_card", name: "Target card", balance: 250 }), true);
  assert.deepEqual((await loadUserAccounts(d, PHONE)).map((a) => [a.name, a.balance, a.owner]), [["Target card", 250, "card"]]);
  const loan = await addAccount(d, PHONE, { type: "auto_loan", name: "Old car", balance: 2000 });
  assert.equal(await updateAccount(d, PHONE, loan, { type: "cd", name: "x", balance: 1 }), false);
  assert.equal(await updateAccount(d, "+19999999999", key, { type: "credit_card", name: "x", balance: 1 }), false); // not theirs
  assert.equal(await removeAccount(d, PHONE, key), true);
  assert.equal(await removeAccount(d, PHONE, "account:../../etc"), false);
  assert.deepEqual(await loadUserAccounts(d, PHONE), []);
});
