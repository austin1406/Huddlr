import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildHuddle, decide, parseDecision, roomToSpend, signLink, statusFor, verifyLink } from "../src/huddle.js";

const facts = () => JSON.parse(readFileSync(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url), "utf8"));
const cast = JSON.parse(readFileSync(new URL("../../contracts/cast.json", import.meta.url), "utf8")).characters;
const noWhatIf = async () => {
  throw new Error("offline");
};

test("huddle puts every account in the right group with net worth from real balances", () => {
  const h = buildHuddle(facts(), cast);
  assert.deepEqual(h.people.filter((p) => p.group === "have").map((p) => p.id), ["checking", "savings", "ira"]);
  assert.deepEqual(h.people.filter((p) => p.group === "owe").map((p) => p.id), ["card", "car_loan"]);
  assert.equal(h.have, 1186.5 + 900 + 8200);
  assert.equal(h.owe, 2400 + 14500);
  assert.equal(h.netWorth, h.have - h.owe);
  assert.equal(h.people.find((p) => p.id === "savings")!.status, "concern"); // runway 0.45 months
  assert.ok(h.people.find((p) => p.id === "card")!.says.includes("48%"));
  assert.equal(h.timeline.days.length, 42);
});

test("safe-to-spend accounts for rent landing after payday", () => {
  const f = facts().forecast; // safe before payday 437.50, but lowest 147.50 on Dec 3 with a 100 cushion
  assert.equal(roomToSpend(f), 47.5);
  const checking = buildHuddle(facts(), cast).people.find((p) => p.id === "checking")!;
  assert.match(checking.says, /Rent on Dec 1 drops me to \$147\.50.*under \$47\.50/);
});

test("Coach suggests the shortfall fix first when a bill would bounce", () => {
  const f = facts();
  f.shortfall = { firstNegativeDate: "2026-11-25", lowestDate: "2026-11-25", amount: 80, accountId: "checking", hoursUntilFirstShortDayEnds: 50, within48Hours: false, suggestedTransfer: 180 };
  f.forecast.firstNegativeDate = "2026-11-25";
  const h = buildHuddle(f, cast);
  assert.match(h.coach.bestMove, /move \$180 from Savings to Checking before Nov 25/);
  assert.equal(h.people.find((p) => p.id === "car_loan")!.status, "concern"); // its payment is that day
});

test("a big purchase makes Checking worried and Coach says not now", async () => {
  const r = await decide(facts(), { kind: "buy", amount: 300 }, noWhatIf);
  const checking = r.reactions.find((x) => x.id === "checking")!;
  assert.equal(r.safe, false);
  assert.equal(checking.mood, "worried");
  assert.match(r.verdict, /^Not right now/);
  assert.equal(r.source, "math");
});

test("a small purchase is fine; P1's what-if numbers win when available", async () => {
  const r = await decide(facts(), { kind: "buy", amount: 20 }, async () => ({ after: { lowestBalance: { date: "2026-12-03", balance: 127.5 }, firstNegativeDate: null } }));
  assert.equal(r.safe, true);
  assert.equal(r.source, "what_if");
  assert.equal(r.reactions.find((x) => x.id === "checking")!.after, "lowest $127.50");
});

test("paying the card shows new utilization and interest saved", async () => {
  const r = await decide(facts(), { kind: "pay_card", amount: 40 }, noWhatIf);
  const card = r.reactions.find((x) => x.id === "card")!;
  assert.equal(card.after, "$2,360");
  assert.match(card.text, /48% to 47%.*\$0\.80 less interest/);
});

test("decisions are validated", () => {
  assert.equal(parseDecision({ kind: "buy", amount: -5 }), null);
  assert.equal(parseDecision({ kind: "steal", amount: 5 }), null);
  assert.equal(parseDecision({ kind: "lose_income", months: 40 }), null);
  assert.deepEqual(parseDecision({ kind: "save", amount: "25.5" }), { kind: "save", amount: 25.5 });
});

test("status rule matches the contract", () => {
  const util = { direction: "lower_is_better", goodAt: 30, concernAt: 70 };
  assert.equal(statusFor(util, 29), "good");
  assert.equal(statusFor(util, 48), "watch");
  assert.equal(statusFor(util, 70), "concern");
});

test("private links verify, expire, and reject tampering", () => {
  const t = signLink("s3cret", "+15550001111", 60, 1_000_000);
  assert.deepEqual(verifyLink("s3cret", t, 1_000_000), { phone: "+15550001111" });
  assert.equal(verifyLink("s3cret", t, 1_000_000 + 61_000), null);
  assert.equal(verifyLink("other", t, 1_000_000), null);
  const [p, s] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ p: "+19999999999", e: 9e9 })).toString("base64url");
  assert.equal(verifyLink("s3cret", `${forged}.${s}`, 1_000_000), null);
  assert.equal(verifyLink("", t, 1_000_000), null);
  assert.ok(p);
});
