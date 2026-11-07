import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FactsSnapshot, Plan } from "../../contracts/src";
import { checkMessage, extractNumbers } from "../src/checker";
import { factsFor } from "../src/character";

const load = (rel: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${rel}`, import.meta.url), "utf8"));
const facts = FactsSnapshot.parse(load("facts.fixture.json"));
const plan = Plan.parse(load("plan.fixture.json"));
const purchase = facts.recentEvents.find((e) => e.type === "big_purchase")!;
const card = factsFor("card", facts, purchase);
const checking = factsFor("checking", facts);

test("grounded Card message passes", () => {
  const r = checkMessage("That $142.37 Target run puts me at $2,400.00 at 24% APR, 48% utilization.", card);
  assert.deepEqual(r.ungrounded, []);
  assert.equal(r.found, 4);
});

test("catches an invented number", () => {
  const r = checkMessage("That charge will cost you $63 in interest this year.", card);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ungrounded.map((u) => u.raw), ["$63"]);
});

test("catches an invented percent and date", () => {
  const r = checkMessage("APR jumps to 29.99% on Jan 15.", card);
  assert.deepEqual(r.ungrounded.map((u) => u.raw).sort(), ["29.99%", "Jan 15"]);
});

test("a number from another character's slice is not grounded for Card", () => {
  assert.equal(checkMessage("You can safely spend $437.50.", checking).ok, true);
  assert.equal(checkMessage("You can safely spend $437.50.", card).ok, false);
});

test("allowed formats: rounding, k, commas, dates", () => {
  for (const msg of [
    "Checking has about $1,186.",
    "Checking has $1,190 left.",
    "Lowest point is $537.50 on Nov 19.",
    "Lowest point is $537.50 on 11/19.",
    "Payday is November 20th.",
    "Payday is 2026-11-20.",
    "Phone bill of $65 is due Nov 12.",
  ]) assert.equal(checkMessage(msg, checking).ok, true, msg);
  assert.equal(checkMessage("Card is at $2.4k.", card).ok, true);
});

test("rounding is not a loophole", () => {
  assert.equal(checkMessage("Checking has $1,250 left.", checking).ok, false);
  assert.equal(checkMessage("Card is at $2.6k.", card).ok, false);
});

test("small counts are always allowed", () => {
  assert.equal(checkMessage("I have 2 ideas and 3 bills.", card).ok, true);
});

test("plan numbers count as grounded when passed in", () => {
  const line = plan.lines[0];
  const msg = `Put $${line.amount} toward ${line.destination}.`;
  assert.equal(checkMessage(msg, card, plan).ok, true);
});

test("ISO dates are read as dates, not three numbers", () => {
  assert.deepEqual(extractNumbers("due 2026-11-20").map((f) => f.kind), ["date"]);
  assert.equal(checkMessage("Rent is due 2026-01-31.", checking).ok, false);
});

test("extractor does not double count", () => {
  assert.equal(extractNumbers("$1,234.56 and 12% on 11/14").length, 3);
});
