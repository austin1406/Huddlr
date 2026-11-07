// H4-5: all six characters, three situations each, through the checker.
// Uses a worst-case model that always invents a number, so every path must end grounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FactsSnapshot, FinanceEvent, Plan } from "../../contracts/src";
import { buildPrompt, cast, factsFor, speak } from "../src/character";
import { checkMessage } from "../src/checker";

const load = (rel: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${rel}`, import.meta.url), "utf8"));
const normal = FactsSnapshot.parse(load("facts.fixture.json"));
const shortfall = FactsSnapshot.parse(load("facts.shortfall.fixture.json"));
const events = FinanceEvent.array().parse(load("events.fixture.json"));
const plan = Plan.parse(load("plan.fixture.json"));
const ev = (t: FinanceEvent["type"]) => events.find((e) => e.type === t)!;

const situations = [
  { name: "big purchase", facts: normal, event: ev("big_purchase") },
  { name: "paycheck landed", facts: normal, event: ev("paycheck_landed") },
  { name: "rent-week shortfall", facts: shortfall, event: ev("forecast_problem") },
];

for (const s of situations)
  for (const c of cast)
    test(`${c.name} / ${s.name}: always ends grounded`, async () => {
      const p = c.id === "coach" ? plan : null;
      const r = await speak(c.id, s.facts, s.name, {
        event: s.event, plan: p, deadline: Date.now() + 60_000, model: async () => "Only $9,999.99 left by Jan 31!",
      });
      assert.equal(r.source, "template");
      const check = checkMessage(r.text, factsFor(c.id, s.facts, s.event), ...(p ? [p] : []));
      assert.deepEqual(check.ungrounded, [], r.text);
    });

test("each prompt carries the character's own account and the event", () => {
  for (const c of cast.filter((x) => x.account)) {
    const prompt = buildPrompt(c.id, normal, "x", ev("big_purchase"));
    assert.match(prompt, new RegExp(`"id":"${c.account}"`), c.id);
    assert.match(prompt, /evt_big_purchase/, c.id);
  }
  assert.match(buildPrompt("coach", normal, "x", null, plan), /PLAN:/);
});
