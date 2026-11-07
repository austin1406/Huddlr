import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FactsSnapshot,
  FinanceEvent,
  Persona,
  Plan,
  SimState,
  WhatIfResult,
  makeEventId,
  FORECAST_DAYS,
  type Indicator,
} from "../src";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), "utf8"));

const facts = FactsSnapshot.parse(load("fixtures/facts.fixture.json"));
const shortfallFacts = FactsSnapshot.parse(load("fixtures/facts.shortfall.fixture.json"));
const events = FinanceEvent.array().parse(load("fixtures/events.fixture.json"));
const plan = Plan.parse(load("fixtures/plan.fixture.json"));
const whatIf = WhatIfResult.parse(load("fixtures/what_if.fixture.json"));
const persona = Persona.parse(load("persona.json"));
SimState.parse(load("fixtures/sim_state.fixture.json"));

const cents = (n: number) => Math.round(n * 100);

function statusFor(i: Indicator): string {
  if (i.direction === "higher_is_better") return i.value >= i.goodAt ? "good" : i.value < i.concernAt ? "concern" : "watch";
  return i.value < i.goodAt ? "good" : i.value >= i.concernAt ? "concern" : "watch";
}

test("persona and thresholds are consistent with the schemas", () => {
  assert.equal(persona.customer.timezone, "America/Chicago");
  assert.ok(persona.recurringBills.length > 0);
});

for (const [name, f] of [
  ["normal", facts],
  ["shortfall", shortfallFacts],
] as const) {
  test(`${name} facts: forecast invariants hold`, () => {
    const fc = f.forecast;
    assert.equal(fc.days.length, FORECAST_DAYS);
    assert.equal(fc.startDate, f.localDate);
    const min = Math.min(...fc.days.map((d) => d.balance));
    assert.equal(cents(fc.lowest.balance), cents(min));
    const beforePayday = fc.days.filter((d) => d.date < fc.nextPayday);
    assert.equal(cents(fc.lowestBeforeNextPayday.balance), cents(Math.min(...beforePayday.map((d) => d.balance))));
    assert.equal(cents(fc.safeToSpendUntilPayday), cents(fc.lowestBeforeNextPayday.balance - fc.cushion));
    assert.equal(fc.firstNegativeDate, fc.days.find((d) => d.balance < 0)?.date ?? null);
    assert.equal(fc.firstBelowCushionDate, fc.days.find((d) => d.balance < fc.cushion)?.date ?? null);
  });

  test(`${name} facts: indicator statuses match their thresholds`, () => {
    for (const i of f.indicators) assert.equal(i.status, statusFor(i), i.id);
    assert.equal(new Set(f.indicators.map((i) => i.id)).size, 5);
  });

  test(`${name} facts: simulated fields are disclosed`, () => {
    for (const a of f.accounts) if (a.simulated) assert.ok(f.simulatedFields.length > 0);
  });
}

test("normal facts have no shortfall", () => {
  assert.equal(facts.shortfall, null);
  assert.ok(facts.forecast.firstNegativeDate === null);
});

test("shortfall facts describe a within-48-hours shortfall with a fix", () => {
  const s = shortfallFacts.shortfall;
  assert.ok(s);
  assert.equal(s.within48Hours, true);
  assert.equal(cents(s.amount), 4300);
  assert.equal(cents(s.suggestedTransfer), cents(s.amount + shortfallFacts.forecast.cushion));
  assert.equal(shortfallFacts.pendingProposals[0]?.status, "pending");
  assert.equal(cents(shortfallFacts.pendingProposals[0]!.amount), cents(s.suggestedTransfer));
});

test("plan lines add up to the amount", () => {
  const total = plan.lines.reduce((sum, l) => sum + l.amount, 0) + plan.unallocated;
  assert.equal(cents(total), cents(plan.amount));
  for (const l of plan.lines) assert.ok(Object.keys(l.reasonNumbers).length > 0, l.reasonCode);
});

test("what-if result changes something and reports days until negative", () => {
  assert.equal(whatIf.scenario.type, "lose_income");
  assert.ok(whatIf.daysUntilNegative !== null && whatIf.daysUntilNegative > 0);
  for (const c of whatIf.changedIndicators) assert.notEqual(c.from, c.to);
});

test("event ids come from the source record and are unique", () => {
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  assert.equal(makeEventId("big_purchase", "nessie-purchase-0412"), "evt_big_purchase_nessie-purchase-0412");
  for (const e of events) assert.ok(e.id.startsWith(`evt_${e.type}_`), e.id);
});
