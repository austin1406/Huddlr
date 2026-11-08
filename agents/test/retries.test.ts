// Gemini for everything: it gets several tries (each told what was wrong), and the pre-written line is only used when
// Gemini is out of quota. Models are faked here; no real Gemini calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FactsSnapshot } from "../../contracts/src";
import { config, speak } from "../src/character";
import { geminiQuota, QuotaError } from "../src/quota";

const facts = FactsSnapshot.parse(JSON.parse(readFileSync(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url), "utf8")));

test("Gemini gets up to 4 tries; a good answer on the 4th is sent, not the pre-written line", async () => {
  assert.equal(config.character_model.max_attempts, 4);
  const prompts: string[] = [];
  let n = 0;
  const model = async (p: string) => {
    prompts.push(p);
    n++;
    return n < 4 ? "You have $9,999.99 saved." : "Your savings is at $900.00.";
  };
  const r = await speak("savings", facts, "How is savings?", { model, deadline: Date.now() + 15000 });
  assert.equal(r.text, "Your savings is at $900.00.");
  assert.equal(r.source, "retry");
  assert.equal(r.attempts.length, 4);
  assert.match(prompts[1], /used numbers not in FACTS: \$9,999\.99/, "each retry is told what was wrong");
  assert.match(prompts[3], /Last try: use only numbers copied exactly from KEY NUMBERS/, "the last try is the strictest");
});

test("out of quota: no more tries, the pre-written line goes out right away", async () => {
  let calls = 0;
  const model = async () => {
    calls++;
    throw new QuotaError("minute", null, "rate limited");
  };
  const r = await speak("savings", facts, "How is savings?", { model, deadline: Date.now() + 15000 });
  assert.equal(r.source, "template");
  assert.equal(calls, 1, "a quota error isn't retried: it would hit the same limit");
  assert.match(r.attempts[0].error ?? "", /quota/);
});

test("a timeout or server error is retried (it isn't 'out of credits')", async () => {
  let n = 0;
  const model = async () => {
    n++;
    if (n === 1) throw new Error("gemini 503: overloaded");
    return "Your savings is at $900.00.";
  };
  const r = await speak("savings", facts, "How is savings?", { model, deadline: Date.now() + 15000 });
  assert.equal(r.text, "Your savings is at $900.00.");
  assert.equal(n, 2);
  assert.equal(geminiQuota.limited(), false);
});
