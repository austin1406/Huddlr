// Hand-checked numbers (Maya on 2026-11-07, window to 2027-01-31 = 86 days):
//   card: 2400 -> x1.02 -72 = 2376 -> 2351.52 -> 2326.5504 after the Nov 28, Dec 28 and Jan 28 statements; interest 48 + 47.52 + 47.0304
//   car loan: 14500 x (1 + 0.069/12) - 320 = 14263.375 -> 14025.3904 -> 13786.0363; interest 83.375 + 82.0154 + 80.6459
//   net worth starts at 1186.50 + 900 + 8200 - 2400 - 14500 = -6613.50
//   it changes by income - bills that are not debt payments - everyday spending - interest:
//     6 paychecks (Nov 20, Dec 4, Dec 18, Jan 1, Jan 15, Jan 29) = 9900
//     rent 2 x 1100 + phone 3 x 65 + utilities 3 x 90 + streaming 3 x 16 = 2713
//     86 days x 38 = 3268;  interest 388.59   =>   -6613.50 + 9900 - 2713 - 3268 - 388.59 = -3083.09
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySimStateStore, ProjectionResponse, TOOL_AUTH_HEADER } from "../../contracts/src";
import { createApp } from "../src/app";
import { PERSONA } from "../src/data/config";
import { EngineBackend } from "../src/engine/backend";
import { horizonDays, strideFor } from "../src/engine/projection";
import { NoProposals } from "../src/proposals";
import { StubBackend } from "../src/stub/backend";

const T0 = Date.parse("2026-11-07T16:00:00.000Z");
const near = (actual: number, expected: number, tol = 0.02) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} is not within ${tol} of ${expected}`);

async function engine() {
  return EngineBackend.create({
    persona: PERSONA,
    store: new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: new Date(T0).toISOString() }),
    gateway: new NoProposals(),
    realNow: () => T0,
  });
}
const run = async (b: EngineBackend, amount: number, unit: "days" | "weeks" | "months" | "years", extra: Record<string, unknown> = {}) =>
  ProjectionResponse.parse(await b.project({ amount, unit, ...extra } as never));

test("window lengths follow the calendar", () => {
  assert.equal(horizonDays("2026-11-07", 30, "days"), 30);
  assert.equal(horizonDays("2026-11-07", 2, "weeks"), 14);
  assert.equal(horizonDays("2026-11-07", 1, "months"), 30); // to Dec 7
  assert.equal(horizonDays("2026-01-31", 1, "months"), 28); // Feb has no 31st: Feb 28
  assert.equal(horizonDays("2026-11-07", 1, "years"), 365);
  assert.equal(horizonDays("2027-03-01", 1, "years"), 366); // spans Feb 29, 2028
  assert.deepEqual([30, 120, 121, 730, 731, 1825].map(strideFor), [1, 1, 7, 7, 30, 30]);
});

test("net worth starts where the accounts are today", async () => {
  const r = await run(await engine(), 30, "days");
  assert.equal(r.current.start.netWorth, -6613.5);
  assert.equal(r.current.start.date, "2026-11-07");
  assert.equal(r.startDate, "2026-11-07");
  assert.equal(r.endDate, "2026-12-06");
});

test("the first 30 days agree with the 45-day forecast, day for day", async () => {
  const b = await engine();
  const facts = await b.facts();
  const r = await run(b, 30, "days");
  assert.equal(r.current.points.length, 30);
  r.current.points.forEach((p, i) => assert.equal(p.checking, facts.forecast.days[i]!.balance, p.date));
});

test("card and car loan interest follow the statements, to the cent", async () => {
  const r = await run(await engine(), 86, "days");
  const end = r.current.points.at(-1)!;
  assert.equal(end.date, "2027-01-31");
  near(end.card, 2326.55);
  near(end.carLoan, 13786.04);
  near(r.current.summary.interestPaid, 388.59, 0.05);
  assert.equal(end.savings, 900);
  assert.equal(end.ira, 8200); // no growth and no contributions assumed
});

test("money is conserved: net worth moves only by income, bills, spending and interest", async () => {
  const r = await run(await engine(), 86, "days");
  near(r.current.summary.endNetWorth, -3083.09, 0.06);
  near(r.current.summary.change, 3530.41, 0.06);
});

test("on the current course cash piles up in checking while the card barely moves", async () => {
  const r = await run(await engine(), 1, "years");
  const end = r.current.points.at(-1)!;
  assert.ok(end.checking > 8000, `checking ${end.checking}`);
  assert.ok(end.card > 1500, `card ${end.card}`); // paying the minimum on 24%: still a long way to go
  assert.ok(r.current.summary.avgMonthlyChangeInChecking! > 600 && r.current.summary.avgMonthlyChangeInChecking! < 900);
  assert.equal(r.current.summary.firstNegativeDate, null);
});

test("long windows show both debts being paid off", async () => {
  const r = await run(await engine(), 6, "years");
  const s = r.current.summary;
  assert.ok(s.carLoanPaidOffDate && s.carLoanPaidOffDate > "2030-12-31" && s.carLoanPaidOffDate < "2031-06-30", String(s.carLoanPaidOffDate)); // about 53 payments
  assert.ok(s.cardPaidOffDate && s.cardPaidOffDate > "2031-03-01" && s.cardPaidOffDate < "2031-09-30", String(s.cardPaidOffDate)); // about 56 payments at the 72 dollar minimum
  const end = r.current.points.at(-1)!;
  assert.equal(end.card, 0);
  assert.equal(end.carLoan, 0);
});

test("IRA growth and savings interest apply only when asked, monthly", async () => {
  const grown = await run(await engine(), 365, "days", { iraReturnPercent: 6, savingsApyPercent: 0 });
  near(grown.current.points.at(-1)!.ira, 8200 * Math.pow(1.005, 12), 0.05); // 8705.76
  const earned = await run(await engine(), 365, "days", { savingsApyPercent: 4.8 });
  near(earned.current.points.at(-1)!.savings, 900 * Math.pow(1.004, 12), 0.05);
  assert.ok(grown.current.assumptions.some((a) => /grows 6% a year/.test(a)));
  assert.ok((await run(await engine(), 30, "days")).current.assumptions.some((a) => /no market return is assumed/.test(a)));
});

test("following the Coach plan beats the current course, and never overdraws checking", async () => {
  const r = await run(await engine(), 2, "years", { compare: true });
  assert.ok(r.coach && r.difference);
  assert.ok(r.difference!.netWorth > 0, `net worth difference ${r.difference!.netWorth}`);
  assert.ok(r.difference!.interestPaid < 0, "less interest paid");
  // the card is gone inside the window with the plan; on the current course it is still owed, so there is no "days earlier" to give
  assert.ok(r.coach!.summary.cardPaidOffDate && r.coach!.summary.cardPaidOffDate < "2027-06-01", String(r.coach!.summary.cardPaidOffDate));
  assert.equal(r.current.summary.cardPaidOffDate, null);
  assert.equal(r.difference!.cardPaidOffDaysEarlier, null);
  assert.ok(r.coach!.points.at(-1)!.card === 0 && r.current.points.at(-1)!.card > 0);
  assert.equal(r.coach!.points.at(-1)!.ira, 13200); // filled to the target, no further
  assert.equal(r.coach!.summary.firstNegativeDate, null);
  assert.ok(r.coach!.summary.lowestChecking.balance >= 0);
  assert.ok(r.coach!.summary.emergencyFundMonthsEnd > r.current.summary.emergencyFundMonthsEnd);
  assert.equal(r.coach!.summary.avgMonthlyChangeInChecking, null);
  assert.ok(r.coach!.assumptions.some((a) => /Coach/.test(a) && /month end/.test(a)));
  const mid = r.coach!.points.find((p) => p.date >= "2027-11-07")!;
  assert.ok(mid.ira >= 8350, "the 150 dollar employer match was captured"); // 8200 + 150
});

test("a window without compare returns no coach path", async () => {
  const r = await run(await engine(), 3, "months");
  assert.equal(r.coach, null);
  assert.equal(r.difference, null);
});

test("a shortfall start shows up as a negative checking day", async () => {
  const b = await engine();
  await b.setScenario("shortfall");
  const r = await run(b, 30, "days");
  assert.equal(r.current.summary.firstNegativeDate, r.startDate);
  assert.ok(r.current.summary.lowestChecking.balance < 0);
});

test("the HTTP route validates the window and the stub says it is engine only", async () => {
  const secret = "s";
  const H = { [TOOL_AUTH_HEADER]: secret, "content-type": "application/json" };
  const app = createApp({ secret, backend: await engine() });
  const post = (body: unknown) => app.request("/tools/project", { method: "POST", headers: H, body: JSON.stringify(body) });
  const ok = await post({ amount: 6, unit: "months", compare: true });
  assert.equal(ok.status, 200);
  ProjectionResponse.parse(await ok.json());
  for (const bad of [{ amount: 0, unit: "days" }, { amount: 11, unit: "years" }, { amount: 3651, unit: "days" }, { amount: 5, unit: "decades" }, { amount: 1.5, unit: "months" }, {}]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await app.request("/tools/project", { method: "POST", body: "{}" })).status, 401);
  const stub = createApp({ secret, backend: new StubBackend() });
  assert.equal((await stub.request("/tools/project", { method: "POST", headers: H, body: JSON.stringify({ amount: 1, unit: "months" }) })).status, 501);
});
