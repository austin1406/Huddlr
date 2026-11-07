import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FactsSnapshot } from "../../contracts/src";
import { cast, factsFor, speak, template } from "../src/character";
import { checkMessage } from "../src/checker";

const load = (rel: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${rel}`, import.meta.url), "utf8"));
const fixtures = {
  normal: FactsSnapshot.parse(load("facts.fixture.json")),
  shortfall: FactsSnapshot.parse(load("facts.shortfall.fixture.json")),
};
const facts = fixtures.normal;
const fake = (...replies: string[]) => { let i = 0; return async () => replies[Math.min(i++, replies.length - 1)]; };
const far = () => Date.now() + 60_000;

test("grounded reply is sent as-is", async () => {
  const r = await speak("card", facts, "x", { model: fake("That puts me at $2,400 at 24% APR."), deadline: far() });
  assert.equal(r.source, "model");
});

test("invented number triggers a retry, retry fixes it", async () => {
  const r = await speak("card", facts, "x", {
    model: fake("That will cost you $63 in interest.", "That adds to my $2,400 balance at 24%."),
    deadline: far(),
  });
  assert.equal(r.source, "retry");
  assert.deepEqual(r.attempts[0].ungrounded?.map((u) => u.raw), ["$63"]);
});

test("invented number twice falls back to the template", async () => {
  const r = await speak("card", facts, "x", { model: fake("$63 of interest!", "Still $63."), deadline: far() });
  assert.equal(r.source, "template");
});

test("no time left: skip the retry, use the template", async () => {
  const r = await speak("card", facts, "x", { model: fake("$63 of interest!"), deadline: Date.now() + 1000 });
  assert.equal(r.source, "template");
  assert.equal(r.attempts.length, 1);
});

test("model error falls back to the template", async () => {
  const r = await speak("card", facts, "x", { model: async () => { throw new Error("503"); }, deadline: far() });
  assert.equal(r.source, "template");
});

test("every template is grounded in its own slice, on both fixtures", () => {
  for (const [name, f] of Object.entries(fixtures))
    for (const c of cast) {
      const r = checkMessage(template(c.id, f), factsFor(c.id, f));
      assert.equal(r.ok, true, `${name}/${c.id}: ${JSON.stringify(r.ungrounded)}`);
    }
});
