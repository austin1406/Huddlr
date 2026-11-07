import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FactsSnapshot, FinanceEvent } from "../../contracts/src";
import { buildDigest, decide, pickSpeakers, type ModeratorContext } from "../src/moderator";
import { checkMessage } from "../src/checker";

const load = (rel: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${rel}`, import.meta.url), "utf8"));
const facts = FactsSnapshot.parse(load("facts.fixture.json"));
const shortfall = FactsSnapshot.parse(load("facts.shortfall.fixture.json"));
const events = FinanceEvent.array().parse(load("events.fixture.json"));
const ev = (type: FinanceEvent["type"]) => events.find((e) => e.type === type)!;

// 2 pm and 11 pm Chicago (CST, UTC-6) on Nov 7, as simulated times.
const afternoon = new Date("2026-11-07T20:00:00.000Z");
const night = new Date("2026-11-08T05:00:00.000Z");
const ctx = (over: Partial<ModeratorContext> = {}): ModeratorContext => ({
  now: afternoon, timezone: "America/Chicago", demoMode: false, proactiveSentToday: 0, alreadyHandled: false, facts, ...over,
});

test("relevance: account owner first, at most 3 speakers, Coach last on plan events", () => {
  const s = pickSpeakers(ev("big_purchase"));
  assert.ok(s.length <= 3);
  assert.equal(s[0], ev("big_purchase").accountId);
  assert.equal(s.at(-1), "coach");
  for (const e of events) assert.ok(pickSpeakers(e).length <= 3, e.type);
});

test("quiet hours send to digest, demo mode bypasses them", () => {
  assert.equal(decide(ev("big_purchase"), ctx({ now: night })).action, "digest");
  assert.equal(decide(ev("big_purchase"), ctx({ now: night, demoMode: true })).action, "react");
});

test("daily cap sends to digest, demo mode relaxes it", () => {
  assert.equal(decide(ev("big_purchase"), ctx({ proactiveSentToday: 5 })).action, "digest");
  assert.equal(decide(ev("big_purchase"), ctx({ proactiveSentToday: 5, demoMode: true })).action, "react");
});

test("emergencies ignore quiet hours and the cap", () => {
  const d = decide(ev("forecast_problem"), ctx({ now: night, proactiveSentToday: 99, facts: shortfall }));
  assert.equal(d.action, "react");
  assert.equal(d.action === "react" && d.priority, 2);
});

test("never reacts to the same event twice", () => {
  assert.equal(decide(ev("big_purchase"), ctx({ alreadyHandled: true })).action, "skip");
});

test("digest is one grounded message", () => {
  const held = events.filter((e) => e.type !== "forecast_problem");
  const text = buildDigest(held)!;
  assert.equal(checkMessage(text, held).ok, true, text);
  assert.equal(buildDigest([]), null);
});
