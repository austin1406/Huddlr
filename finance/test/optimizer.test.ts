import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySimStateStore, Plan, TOOL_AUTH_HEADER } from "../../contracts/src";
import { createApp } from "../src/app";
import { PERSONA } from "../src/data/config";
import { FIXTURES } from "../src/data/fixtures";
import { EngineBackend } from "../src/engine/backend";
import { planV1 } from "../src/engine/optimizer";
import { planV0 } from "../src/engine/plan";
import { NoProposals } from "../src/proposals";

const normal = FIXTURES.normal;
const shortfall = FIXTURES.shortfall;
const plan = (amount: number, facts = normal) => planV1(facts, PERSONA.goals, amount);
const shape = (p: Plan) => p.lines.map((l) => [l.destination, l.amount, l.reasonCode]);

// Persona numbers the expectations come from: card owed 2400 at 24%; savings 900 against essentials 2007 (1 month = 2007,
// 3 months = 6021); unclaimed match 150; IRA 8200 toward 13200; trip goal 300 of 1500; car loan 14500 at 6.9% (not high-interest).

test("v1 puts the employer match first, then the 24% card", () => {
  assert.deepEqual(shape(plan(100)), [["ira", 100, "capture_employer_match"]]);
  assert.deepEqual(shape(plan(600)), [
    ["ira", 150, "capture_employer_match"],
    ["card", 450, "pay_high_interest_debt"],
  ]);
  assert.equal(plan(600).lines[1]!.reasonNumbers.monthlyInterestSaved, 9); // 450 x 24% / 12
});

test("v1 then builds the emergency fund to one month, then funds the goal, then to three months", () => {
  assert.deepEqual(shape(plan(3000)), [["ira", 150, "capture_employer_match"], ["card", 2400, "pay_high_interest_debt"], ["savings", 450, "build_emergency_fund"]]);
  assert.deepEqual(shape(plan(4000)), [
    ["ira", 150, "capture_employer_match"],
    ["card", 2400, "pay_high_interest_debt"],
    ["savings", 1107, "build_emergency_fund"],
    ["goal:trip", 343, "fund_goal"],
  ]);
  const six = plan(6000);
  assert.deepEqual(shape(six), [
    ["ira", 150, "capture_employer_match"],
    ["card", 2400, "pay_high_interest_debt"],
    ["savings", 1107, "build_emergency_fund"],
    ["goal:trip", 1200, "fund_goal"],
    ["savings", 1143, "build_emergency_fund"],
  ]);
  assert.deepEqual([six.lines[2]!.reasonNumbers.targetMonths, six.lines[4]!.reasonNumbers.targetMonths], [1, 3]);
  assert.equal(six.lines[4]!.reasonNumbers.runwayMonthsAfter, 1.57); // (900 + 1107 + 1143) / 2007 months
});

test("v1 splits what is left between retirement and the car loan, and leaves what nothing can use", () => {
  assert.deepEqual(shape(plan(10000)).slice(-2), [["ira", 564.5, "extra_retirement"], ["car_loan", 564.5, "extra_debt_payment"]]);
  const huge = plan(30000);
  // IRA room is 13200 - (8200 + 150 match) = 4850; the car loan takes its whole 14500; the rest has nowhere to go
  assert.deepEqual(shape(huge).slice(-2), [["ira", 4850, "extra_retirement"], ["car_loan", 14500, "extra_debt_payment"]]);
  assert.equal(huge.unallocated, 1779);
});

test("v1 covers a shortfall plus the cushion before anything else", () => {
  assert.deepEqual(shape(plan(143, shortfall)), [["checking", 143, "cover_shortfall"]]);
  const more = plan(500, shortfall);
  assert.deepEqual(shape(more), [
    ["checking", 143, "cover_shortfall"],
    ["ira", 150, "capture_employer_match"],
    ["card", 207, "pay_high_interest_debt"],
  ]);
  assert.equal(more.shortfallCovered, 143);
  assert.equal(plan(100, shortfall).shortfallCovered, 100); // a partial cover takes it all
});

test("v1 plans always add up and never overfill a destination", () => {
  for (const facts of [normal, shortfall]) {
    for (const amount of [1, 37.5, 143, 150.01, 600, 2400, 2550.5, 4000, 6021, 10000, 25000, 50000]) {
      const p = plan(amount, facts);
      Plan.parse(p);
      const total = p.lines.reduce((s, l) => s + l.amount, 0) + p.unallocated;
      assert.equal(Math.round(total * 100), Math.round(amount * 100), `${amount}`);
      for (const l of p.lines) assert.ok(l.amount > 0, `${amount} ${l.destination}`);
      const to = (d: string) => p.lines.filter((l) => l.destination === d).reduce((s, l) => s + l.amount, 0);
      assert.ok(to("card") <= 2400 + 1e-9 && to("car_loan") <= 14500 + 1e-9, `${amount} debts`);
      assert.ok(to("goal:trip") <= 1200 + 1e-9, `${amount} goal`);
      assert.ok(to("savings") <= 6021 - 900 + 1e-9, `${amount} savings`);
      assert.ok(to("ira") <= 150 + 4850 + 1e-9, `${amount} ira`);
    }
  }
});

test("v0 is unchanged and still available", () => {
  assert.deepEqual(planV0(normal, 600).lines.map((l) => [l.destination, l.amount]), [["card", 600]]);
});

test("the live switch changes get_plan between v1 and v0", async () => {
  const backend = await EngineBackend.create({
    persona: PERSONA,
    store: new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: "2026-11-07T16:00:00.000Z" }),
    gateway: new NoProposals(),
    realNow: () => Date.parse("2026-11-07T16:00:00.000Z"),
  });
  const app = createApp({ secret: "s", backend });
  const H = { [TOOL_AUTH_HEADER]: "s", "content-type": "application/json" };
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: H, body: JSON.stringify(body) });
  const first = async () => Plan.parse(await (await post("/tools/get_plan", { amount: 600, source: "bonus" })).json()).lines.map((l) => l.reasonCode);

  assert.deepEqual(await first(), ["capture_employer_match", "pay_high_interest_debt"]); // v1 is the default
  assert.equal((await post("/admin/plan-version", { version: "v0" })).status, 200);
  assert.deepEqual(await first(), ["pay_high_interest_debt"]);
  assert.equal((await backend.engine.state()).planVersion, "v0");
  assert.equal((await post("/admin/plan-version", { version: "v2" })).status, 400);
  await post("/admin/plan-version", { version: "v1" });
  assert.deepEqual(await first(), ["capture_employer_match", "pay_high_interest_debt"]);
});
