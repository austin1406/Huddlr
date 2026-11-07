import { test } from "node:test";
import assert from "node:assert/strict";
import { CanIAffordResponse, Plan, WhatIfResult } from "../../contracts/src";
import { FIXTURES } from "../src/data/fixtures";
import { canIAfford } from "../src/engine/afford";
import { planV0 } from "../src/engine/plan";
import { whatIf } from "../src/engine/whatif";

const normal = FIXTURES.normal;
const shortfall = FIXTURES.shortfall;
const cents = (n: number) => Math.round(n * 100);

test("can_i_afford: yes, tight, and no against the normal forecast (lowest 147.50, cushion 100)", () => {
  const yes = canIAfford(normal, 40);
  assert.equal(yes.verdict, "yes");
  assert.equal(yes.lowestBalanceAfter.balance, 107.5);
  assert.equal(yes.lowestBalanceAfter.date, "2026-12-03");
  assert.equal(yes.firstNegativeDateAfter, null);

  assert.equal(canIAfford(normal, 47.5).verdict, "yes"); // lands exactly on the cushion
  assert.equal(canIAfford(normal, 50).verdict, "tight");
  assert.equal(canIAfford(normal, 147.5).verdict, "tight"); // lands exactly on zero
  const no = canIAfford(normal, 150);
  assert.equal(no.verdict, "no");
  assert.ok(no.firstNegativeDateAfter);
  CanIAffordResponse.parse(no);
});

test("can_i_afford: any purchase in a shortfall week is a no", () => {
  const r = canIAfford(shortfall, 10);
  assert.equal(r.verdict, "no");
  assert.equal(r.firstNegativeDateAfter, "2026-12-02");
});

test("plan v0 sends a bonus to the highest-APR debt first", () => {
  const plan = planV0(normal, 600);
  Plan.parse(plan);
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.lines[0]!.destination, "card");
  assert.equal(plan.lines[0]!.amount, 600);
  assert.equal(plan.lines[0]!.reasonNumbers.monthlyInterestSaved, 12); // 600 * 24% / 12
  assert.equal(plan.unallocated, 0);
});

test("plan v0 overflows to the emergency fund, then leaves the rest unallocated", () => {
  const plan = planV0(normal, 4000);
  assert.deepEqual(
    plan.lines.map((l) => [l.destination, l.amount]),
    [
      ["card", 2400],
      ["savings", 1107],
    ],
  );
  assert.equal(plan.unallocated, 493);
});

test("plan v0 covers a shortfall plus the cushion before anything else", () => {
  const plan = planV0(shortfall, 143);
  assert.equal(plan.lines[0]!.reasonCode, "cover_shortfall");
  assert.equal(plan.lines[0]!.destination, "checking");
  assert.equal(plan.shortfallCovered, 143);
  const bigger = planV0(shortfall, 500);
  assert.deepEqual(
    bigger.lines.map((l) => l.reasonCode),
    ["cover_shortfall", "pay_high_interest_debt"],
  );
});

test("plan lines always add up to the amount", () => {
  for (const amount of [1, 37.5, 143, 600, 2400.01, 4000, 10000]) {
    for (const facts of [normal, shortfall]) {
      const plan = planV0(facts, amount);
      const total = plan.lines.reduce((s, l) => s + l.amount, 0) + plan.unallocated;
      assert.equal(cents(total), cents(amount), `${amount}`);
    }
  }
});

test("what-if purchase_now is computed; other scenarios echo the fixture shape", () => {
  const p = whatIf(normal, { type: "purchase_now", amount: 50 }, FIXTURES.whatIf);
  WhatIfResult.parse(p);
  assert.equal(p.after.lowestBalance.balance, 97.5);
  assert.equal(p.before.lowestBalance.balance, 147.5);
  assert.equal(p.daysUntilNegative, null);

  const lose = whatIf(normal, { type: "lose_income", months: 1 }, FIXTURES.whatIf);
  assert.equal(lose.scenario.type, "lose_income");
  assert.equal(lose.daysUntilNegative, FIXTURES.whatIf.daysUntilNegative);
});
