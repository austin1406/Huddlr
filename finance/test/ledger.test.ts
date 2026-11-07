import { test } from "node:test";
import assert from "node:assert/strict";
import { FactsSnapshot, WhatIfResult } from "../../contracts/src";
import { PERSONA } from "../src/data/config";
import { FIXTURES } from "../src/data/fixtures";
import { endOfLocalDay, nextPaydayAfter } from "../src/engine/calendar";
import { buildFacts } from "../src/engine/facts";
import { createLedger, last30Days, postBill, postPaycheck, postPurchase, postTransfer, settleThrough } from "../src/engine/ledger";
import { whatIf } from "../src/engine/whatif";

const NOW = new Date("2026-11-07T16:00:00.000Z"); // 10:00 in Chicago
const TODAY = "2026-11-07";
const fresh = () => createLedger(PERSONA, TODAY);
const at = (date: string) => new Date(`${date}T16:00:00.000Z`);

test("engine facts match the contract fixture for the normal day", () => {
  const facts = buildFacts(fresh(), PERSONA, NOW);
  FactsSnapshot.parse(facts);
  assert.deepEqual(facts, { ...FIXTURES.normal, recentEvents: [], pendingProposals: [] });
});

test("engine facts match the contract fixture for the rent-week shortfall", () => {
  const ledger = createLedger(PERSONA, "2026-12-02", { checking: 33, lastPaidDaysAgo: 12 });
  const facts = buildFacts(ledger, PERSONA, new Date(FIXTURES.shortfall.asOf));
  assert.deepEqual(facts, { ...FIXTURES.shortfall, recentEvents: [], pendingProposals: [] });
  assert.equal(facts.shortfall?.suggestedTransfer, 143);
});

test("calendar: payday schedule and end of local day", () => {
  assert.equal(nextPaydayAfter("2026-11-06", 14, "2026-11-07"), "2026-11-20");
  assert.equal(nextPaydayAfter("2026-11-06", 14, "2026-11-20"), "2026-12-04");
  assert.equal(endOfLocalDay("2026-12-02", "America/Chicago").toISOString(), "2026-12-03T06:00:00.000Z"); // CST
  assert.equal(endOfLocalDay("2026-07-01", "America/Chicago").toISOString(), "2026-07-02T05:00:00.000Z"); // CDT
});

test("settling days applies paycheck, bills and daily spend, and is safe to repeat", () => {
  const l = fresh();
  settleThrough(l, PERSONA, "2026-11-21"); // settles Nov 7 to Nov 20; payday is Nov 20
  const once = JSON.stringify(l);
  assert.equal(l.settledThrough, "2026-11-20");
  assert.equal(l.lastPaid, "2026-11-20");
  assert.deepEqual(settleThrough(l, PERSONA, "2026-11-21"), []);
  assert.equal(JSON.stringify(l), once);
  // 14 days of 38 spend, phone (65) on Nov 12, utilities (90) on Nov 18, one paycheck
  assert.equal(l.balances.checking, 1186.5 - 14 * 38 - 65 - 90 + 1650);
  assert.equal(l.txns.filter((t) => t.kind === "paycheck").length, 1);
});

test("rent and debt payments reduce the balances they pay", () => {
  const l = fresh();
  settleThrough(l, PERSONA, "2026-12-02");
  assert.equal(l.txns.find((t) => t.id === "sim-bill-rent-2026-12-01")?.amount, 1100);
  assert.equal(l.balances.car_loan, 14500 - 320); // car_loan payment on Nov 25
  assert.equal(l.balances.card, 2400 - 72); // card minimum on Nov 28
  assert.ok(l.onTimeBillStreak > PERSONA.spending.onTimeBillStreak);
});

test("a bill paid from an overdrawn account resets the on-time streak", () => {
  const l = fresh();
  l.balances.checking = 50;
  settleThrough(l, PERSONA, "2026-11-13"); // phone is due Nov 12 and checking is about -30 by then
  assert.equal(l.txns.find((t) => t.id === "sim-bill-phone-2026-11-12")?.late, true);
  assert.equal(l.onTimeBillStreak, 0);
});

test("purchases, transfers, paychecks and one-off bills change the forecast", () => {
  const l = fresh();
  postPurchase(l, TODAY, NOW.toISOString(), { amount: 50, merchant: "Target" });
  assert.equal(l.balances.checking, 1136.5);
  postPurchase(l, TODAY, NOW.toISOString(), { amount: 100, merchant: "Apple", account: "card" });
  assert.equal(l.balances.card, 2500);
  assert.equal(l.balances.checking, 1136.5);
  postTransfer(l, TODAY, NOW.toISOString(), "savings", "checking", 200);
  assert.deepEqual([l.balances.savings, l.balances.checking], [700, 1336.5]);

  const before = buildFacts(l, PERSONA, NOW).forecast.lowest.balance;
  postBill(l, { label: "Vet", amount: 300, dueDate: "2026-11-09" });
  assert.equal(buildFacts(l, PERSONA, NOW).forecast.lowest.balance, before - 300);

  postPaycheck(l, TODAY, NOW.toISOString());
  assert.equal(l.lastPaid, TODAY);
  const facts = buildFacts(l, PERSONA, NOW);
  assert.equal(facts.forecast.nextPayday, "2026-11-21");
  // a paycheck posted today is never counted again on day 0 of the forecast
  assert.equal(facts.upcomingPaychecks[0]?.date, "2026-11-21");
});

test("forecast day count and bills: month-end clamping and a bill due today", () => {
  const l = createLedger(PERSONA, "2027-02-27");
  const facts = buildFacts(l, PERSONA, at("2027-02-27"));
  assert.equal(facts.forecast.days.length, 45);
  assert.ok(facts.upcomingBills.some((b) => b.id === "card_minimum" && b.dueDate === "2027-02-28"));
});

test("savings rate starts at the persona baseline and fades as real history builds", () => {
  const l = fresh();
  assert.deepEqual(last30Days(l, PERSONA, TODAY), { income: 3300, spending: 2950 });
  settleThrough(l, PERSONA, "2026-12-08"); // 31 days later: baseline gone, only simulated history remains
  const w = last30Days(l, PERSONA, "2026-12-08");
  assert.ok(w.income > 0 && w.income <= 3300 + 1);
  assert.ok(w.spending > 2000);
});

test("what-if: purchase, one-time expense, new recurring bill and lost income", () => {
  const l = fresh();
  const buy = whatIf(l, PERSONA, NOW, { type: "purchase_now", amount: 50 });
  WhatIfResult.parse(buy);
  assert.equal(buy.before.lowestBalance.balance, 147.5);
  assert.equal(buy.after.lowestBalance.balance, 97.5);
  assert.equal(buy.daysUntilNegative, null);

  const big = whatIf(l, PERSONA, NOW, { type: "one_time_expense", amount: 1200, date: "2026-11-10", label: "Car repair" });
  assert.equal(big.after.firstNegativeDate, "2026-11-10");
  assert.equal(big.daysUntilNegative, 3);

  const rec = whatIf(l, PERSONA, NOW, { type: "new_recurring", amount: 60, dayOfMonth: 15, label: "Gym" });
  assert.ok(rec.after.lowestBalance.balance < rec.before.lowestBalance.balance);

  const lose = whatIf(l, PERSONA, NOW, { type: "lose_income", months: 2 });
  WhatIfResult.parse(lose);
  assert.ok(lose.after.firstNegativeDate && lose.after.firstNegativeDate > "2026-11-07");
  assert.deepEqual(lose.changedIndicators.map((c) => [c.id, c.to]), [["savings_rate", "concern"]]);
  assert.equal(lose.before.firstNegativeDate, null);
  // what-if never touches the real ledger
  assert.equal(l.balances.checking, 1186.5);
  assert.equal(l.txns.length, 0);
});
