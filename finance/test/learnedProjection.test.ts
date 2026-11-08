// The projection with the learned model: a likely range, risk numbers, learning from what the ledger sees, and finding
// recurring payments nobody mentioned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySimStateStore, ProjectionResponse } from "../../contracts/src";
import { PERSONA } from "../src/data/config";
import { EngineBackend } from "../src/engine/backend";
import { NoProposals } from "../src/proposals";

const T0 = Date.parse("2026-11-07T16:00:00.000Z"); // 10:00 in Chicago

async function engine() {
  return EngineBackend.create({
    persona: PERSONA,
    store: new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: new Date(T0).toISOString() }),
    gateway: new NoProposals(),
    realNow: () => T0,
  });
}
const run = async (b: EngineBackend, amount: number, unit: "days" | "weeks" | "months" | "years", extra: Record<string, unknown> = {}) =>
  ProjectionResponse.parse(JSON.parse(JSON.stringify(await b.project({ amount, unit, ...extra } as never))));

test("every path gets a likely range that lines up with its points", async () => {
  const r = await run(await engine(), 1, "years", { compare: true });
  for (const p of [r.current, r.coach!]) {
    const u = p.uncertainty!;
    assert.equal(u.runs, 300);
    assert.equal(u.p10.length, p.points.length);
    assert.equal(u.p50.length, p.points.length);
    assert.equal(u.p90.length, p.points.length);
    u.p10.forEach((lo, i) => assert.ok(lo <= u.p50[i]! && u.p50[i]! <= u.p90[i]!, `ordered at ${i}`));
    assert.ok(u.endNetWorth.p10 < u.endNetWorth.p90);
    for (const v of [u.probCheckingNegative, u.probCardPaidOffByEnd]) assert.ok(v >= 0 && v <= 1);
  }
});

test("the middle of the range sits near the expected path", async () => {
  const r = await run(await engine(), 1, "years");
  const exp = r.current.points.at(-1)!.netWorth, mid = r.current.uncertainty!.endNetWorth.p50;
  assert.ok(Math.abs(exp - mid) < 600, `expected ${exp}, middle ${mid}`);
  assert.ok(r.current.uncertainty!.endNetWorth.p10 < exp && exp < r.current.uncertainty!.endNetWorth.p90);
});

test("the range widens the further out you look", async () => {
  const b = await engine();
  const width = async (amount: number, unit: "months" | "years") => {
    const u = (await run(b, amount, unit)).current.uncertainty!.endNetWorth;
    return u.p90 - u.p10;
  };
  const m6 = await width(6, "months"), y2 = await width(2, "years"), y5 = await width(5, "years");
  assert.ok(m6 < y2 && y2 < y5, `${m6} < ${y2} < ${y5}`);
});

test("the same question always gets the same answer", async () => {
  const a = await run(await engine(), 2, "years", { compare: true });
  const b = await run(await engine(), 2, "years", { compare: true });
  assert.deepEqual(a, b);
});

test("both strategies face the same random futures, so the comparison is fair", async () => {
  const r = await run(await engine(), 2, "years", { compare: true });
  // a two-year window samples every 30 days; before the plan has swept anything the two ranges are identical
  assert.deepEqual(r.coach!.uncertainty!.p50.slice(0, 2), r.current.uncertainty!.p50.slice(0, 2));
  assert.ok(r.coach!.uncertainty!.endNetWorth.p50 > r.current.uncertainty!.endNetWorth.p50);
});

test("the risk of a shortfall is stated even when the single line looks fine", async () => {
  const r = await run(await engine(), 30, "days");
  // the forecast's lowest day is $147.50: fine on paper, but a few heavier spending days can erase it
  assert.equal(r.current.summary.firstNegativeDate, null);
  assert.ok(r.current.uncertainty!.probCheckingNegative > 0.1 && r.current.uncertainty!.probCheckingNegative < 0.6, String(r.current.uncertainty!.probCheckingNegative));
});

test("runs: 0 and model: simple switch the range off and the simple model reproduces the original flat $38 numbers", async () => {
  const b = await engine();
  assert.equal((await run(b, 6, "months", { runs: 0 })).current.uncertainty, null);
  const simple = await run(b, 86, "days", { model: "simple" });
  assert.equal(simple.current.uncertainty, null);
  assert.equal(simple.current.model!.kind, "simple");
  assert.ok(Math.abs(simple.current.summary.endNetWorth - -3083.09) < 0.06); // the hand-checked figure in projection.test.ts
  assert.ok(simple.current.assumptions.some((a) => /stays at \$38 a day/.test(a)));
});

test("with no history yet the model says so and uses the profile", async () => {
  const m = (await run(await engine(), 30, "days")).current.model!;
  assert.equal(m.kind, "learned");
  assert.equal(m.basis, "profile");
  assert.equal(m.dailySpendMean, 38);
  assert.equal(m.daysObserved, 0);
  assert.ok(m.dailySpendSd > 45 && m.dailySpendSd < 52);
});

test("it learns: three weeks of heavy spending moves the forecast, and says why", async () => {
  const b = await engine();
  const before = (await run(b, 6, "months", { runs: 0 })).current.summary.endNetWorth;
  for (let d = 0; d < 21; d++) {
    await b.engine.purchase({ amount: 60, merchant: "Weekend trips" });
    await b.engine.jumpDays(1);
  }
  const r = await run(b, 6, "months", { runs: 0 });
  const m = r.current.model!;
  assert.equal(m.basis, "history");
  assert.equal(m.daysObserved, 21);
  assert.ok(m.dailySpendMean > 60 && m.dailySpendMean < 98, `learned level ${m.dailySpendMean}`); // up from 38, but not all the way to 98 on three weeks of evidence
  assert.ok(m.weightOnHistory > 0.3 && m.weightOnHistory < 1);
  assert.ok(r.current.summary.endNetWorth < before - 2000, "the projection reflects the new habit");
  assert.ok(r.current.assumptions.some((a) => /learned from your last 21 days/.test(a)));
});

test("a subscription the engine was never told about is found and included", async () => {
  const b = await engine();
  await b.engine.purchase({ amount: 50, merchant: "Gym" });
  for (const gap of [30, 31, 31]) {
    await b.engine.jumpDays(gap);
    await b.engine.purchase({ amount: 50, merchant: "Gym" });
  }
  const learned = await run(b, 4, "months", { runs: 0 });
  const simple = await run(b, 4, "months", { runs: 0, model: "simple" });
  const found = learned.current.model!.detectedRecurring;
  assert.equal(found.length, 1);
  assert.deepEqual([found[0]!.label, found[0]!.amount, found[0]!.everyDays, found[0]!.seen], ["Gym", 50, 30, 3]); // four charges, but the 90-day window starts after the first
  assert.equal(found[0]!.nextDate, "2027-03-07");
  assert.ok(learned.current.assumptions.some((a) => /Found a payment that repeats: Gym, \$50 a month \(seen 3 times\)/.test(a)));
  // Mar 7, Apr 7 and May 7 fall inside the window: three charges the simple model knows nothing about
  const gap = simple.current.points.at(-1)!.checking - learned.current.points.at(-1)!.checking;
  assert.ok(Math.abs(gap - 150) < 1, `checking is ${gap} lower, expected 150`);
});

test("the Coach plan leaves room for random spending, so it is not riskier than doing nothing", async () => {
  // Found by simulation: with no room above a month of bills and the cushion, the plan overdrew checking in 66% of
  // 5-year futures against 29% for doing nothing. Leaving two standard deviations of a month's spending closes the gap.
  const r = await run(await engine(), 5, "years", { compare: true });
  const current = r.current.uncertainty!.probCheckingNegative, coach = r.coach!.uncertainty!.probCheckingNegative;
  assert.ok(coach <= current + 0.06, `coach ${coach} vs current ${current}`);
  assert.ok(r.coach!.assumptions.some((a) => /room for random spending/.test(a)));
  assert.ok(r.difference!.netWorth > 0, "and it still ends ahead");
});
