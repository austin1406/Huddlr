// The learned spending model: what it believes at the start, how far evidence moves it, what it finds, and how well it
// forecasts compared with a flat average. Backtest numbers are in docs/finance.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSONA } from "../src/data/config";
import { flatMethod, learnedMethod, meanMethod, rangeCoverage, scoreScenario } from "../src/engine/backtest";
import { createLedger } from "../src/engine/ledger";
import { buildHistory, detectRecurring, estimateLevel, fitSpendModel, mulberry32, nextMonthly, priorFromPersona, type SpendItem } from "../src/engine/spending";

const prior = priorFromPersona(PERSONA);

test("the profile's belief: a $38 day, spread worked out from the merchants", () => {
  // compound Poisson per merchant: mean = sum(lambda x mid), variance = sum(lambda x (lo^2 + lo*hi + hi^2) / 3), scaled to $38
  assert.equal(prior.mean, 38);
  assert.ok(prior.sd > 48 && prior.sd < 49.5, `sd ${prior.sd}`); // about 48.6
  const rng = mulberry32(7);
  const draws = Array.from({ length: 20000 }, () => prior.draw(rng));
  const mean = draws.reduce((s, v) => s + v, 0) / draws.length;
  assert.ok(Math.abs(mean - 38) < 1, `simulated mean ${mean}`);
});

test("evidence moves the level only as far as it justifies", () => {
  const rng = mulberry32(11);
  const steady = Array.from({ length: 60 }, () => prior.draw(rng));
  const a = estimateLevel(steady, prior);
  assert.ok(Math.abs(a.mean - 38) < 6, `steady level ${a.mean}`); // ordinary noise barely moves it
  assert.ok(a.weightOnData > 0.2 && a.weightOnData < 0.9);

  const doubled = Array.from({ length: 60 }, () => prior.draw(rng) * 2);
  const b = estimateLevel(doubled, prior);
  assert.ok(b.mean > 52 && b.mean < 76, `after a real change ${b.mean}`); // moves a long way, but not all the way at once
  assert.ok(b.mean > a.mean + 15);

  const none = estimateLevel([], prior);
  assert.deepEqual([none.mean, none.priorMean, none.weightOnData, none.daysObserved], [38, 38, 0, 0]);
  assert.ok(Math.abs(none.se - 7.6) < 1e-9); // the prior is believed to be off by about 20%
  assert.equal(estimateLevel([120, 90, 10], prior).mean, 38); // under a week of days: the profile as is
});

test("history is one number per day: the log's past, then what the ledger booked", () => {
  const state = createLedger(PERSONA, "2026-11-07");
  state.history = [
    { date: "2026-11-04", amount: 40, description: "H-E-B" },
    { date: "2026-11-04", amount: 10, description: "Starbucks" },
    { date: "2026-11-05", amount: 25, description: "Shell" },
  ];
  const t = { occurredAt: "2026-11-07T12:00:00.000Z", accountId: "checking" as const };
  state.txns.push(
    { id: "d7", date: "2026-11-07", kind: "daily", amount: 38, ...t },
    { id: "p7", date: "2026-11-07", kind: "purchase", amount: 100, merchant: "Apple", ...t },
    { id: "d8", date: "2026-11-08", kind: "daily", amount: 38, ...t },
  );
  const h = buildHistory(state, "2026-11-09", 90);
  assert.deepEqual(h.dates, ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
  assert.deepEqual(h.values, [50, 25, 0, 138, 38]); // a quiet day counts as a zero; a purchase sits on top of the background
  assert.equal(h.items.length, 6);
  assert.equal(buildHistory(createLedger(PERSONA, "2026-11-07"), "2026-11-07", 90).values.length, 0); // nothing seen yet
});

const monthly = (label: string, amount: number, dates: string[]): SpendItem[] => dates.map((date) => ({ date, amount, description: label }));

test("a payment that repeats on a rhythm is found; coffee runs and grocery trips are not", () => {
  const gym = monthly("Gym", 50, ["2026-08-03", "2026-09-03", "2026-10-03", "2026-11-03"]);
  const found = detectRecurring(gym, "2026-11-08");
  assert.deepEqual(found.map((r) => [r.label, r.amount, r.everyDays, r.nextDate, r.seen]), [["Gym", 50, 30, "2026-12-03", 4]]);

  const weekly = monthly("Farmers market", 24, ["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31", "2026-11-07"]);
  assert.deepEqual(detectRecurring(weekly, "2026-11-08").map((r) => [r.everyDays, r.nextDate]), [[7, "2026-11-14"]]);

  const coffee = monthly("Starbucks", 7, ["2026-11-01", "2026-11-02", "2026-11-05", "2026-11-06", "2026-11-08"]);
  assert.deepEqual(detectRecurring(coffee, "2026-11-09"), []); // no rhythm
  assert.deepEqual(detectRecurring(monthly("Dinner", 40, ["2026-08-03", "2026-09-03", "2026-10-03", "2026-11-03"]).map((x, i) => ({ ...x, amount: [40, 90, 25, 70][i]! })), "2026-11-08"), []); // amounts all over the place
  assert.deepEqual(detectRecurring(monthly("Old subscription", 15, ["2026-03-03", "2026-04-03", "2026-05-03"]), "2026-11-08"), []); // it stopped
  assert.deepEqual(detectRecurring(monthly("Rent", 1100, ["2026-08-01", "2026-09-01", "2026-10-01"]), "2026-10-20", new Set(["rent"])), []); // already known
  assert.deepEqual(detectRecurring(monthly("Gym", 50, ["2026-09-03", "2026-10-03"]), "2026-10-20"), []); // twice is a coincidence
});

test("the profile's own merchants, over a year of random days, never look like a subscription", () => {
  const rng = mulberry32(3);
  const items: SpendItem[] = [];
  for (let d = 0; d < 365; d++) {
    for (const m of PERSONA.seedHints.merchants) {
      const visits = rng() < m.perWeek / 7 ? 1 : 0;
      if (visits) items.push({ date: new Date(Date.UTC(2026, 0, 1) + d * 864e5).toISOString().slice(0, 10), amount: m.typicalAmount[0] + Math.round(rng() * (m.typicalAmount[1] - m.typicalAmount[0])), description: m.name });
    }
  }
  assert.deepEqual(detectRecurring(items, "2026-12-31"), []);
});

test("monthly dates clamp to the month's length", () => {
  assert.equal(nextMonthly("2026-01-31"), "2026-02-28");
  assert.equal(nextMonthly("2026-12-15"), "2027-01-15");
  assert.equal(nextMonthly("2028-01-31"), "2028-02-29");
});

test("a found subscription is taken out of the everyday level so it is not counted twice", () => {
  const state = createLedger(PERSONA, "2026-11-08");
  const dates = ["2026-08-03", "2026-09-03", "2026-10-03", "2026-11-03"];
  state.history = dates.map((date) => ({ date, amount: 50, description: "Gym" }));
  for (let d = 0; d < 100; d++) {
    const date = new Date(Date.UTC(2026, 7, 1) + d * 864e5).toISOString().slice(0, 10);
    if (date < "2026-11-08") state.history.push({ date, amount: 38, description: "Everyday store" });
  }
  const model = fitSpendModel(state, PERSONA, "2026-11-08");
  assert.equal(model.recurring.length, 1);
  assert.equal(model.recurring[0]!.label, "Gym");
  const withGymDays = model.dates.filter((d) => dates.includes(d)).map((d) => model.values[model.dates.indexOf(d)]);
  assert.equal(model.recurring[0]!.seen, 3); // the 90-day window holds Sep, Oct and Nov; Aug 3 is just outside it
  assert.deepEqual(withGymDays, [38, 38, 38]); // the $50 is out; only everyday spending is left
});

test("backtest: when habits change the learned level forecasts better than a flat $38", () => {
  const flat = flatMethod(prior.mean);
  const learned = learnedMethod(prior);
  for (const scenario of ["jump", "drop", "drift"]) {
    const f = scoreScenario(PERSONA, scenario, flat, 25), l = scoreScenario(PERSONA, scenario, learned, 25);
    assert.ok(l.mae < f.mae, `${scenario}: learned ${l.mae.toFixed(0)} vs flat ${f.mae.toFixed(0)}`);
  }
  // and when habits do not change it costs almost nothing, where plain averaging of history costs a lot
  const steadyFlat = scoreScenario(PERSONA, "steady", flat, 25).mae;
  assert.ok(scoreScenario(PERSONA, "steady", learned, 25).mae < steadyFlat * 1.08);
  assert.ok(scoreScenario(PERSONA, "steady", meanMethod, 25).mae > steadyFlat * 1.05);
});

test("backtest: the 80% range holds about 80% of what actually happened when spending is steady", () => {
  const coverage = rangeCoverage(PERSONA, "steady", 15);
  assert.ok(coverage > 0.72 && coverage < 0.88, `coverage ${coverage}`);
});
