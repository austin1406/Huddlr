import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReply } from "../src/reply";

const cases: Record<"yes" | "no" | "unclear", string[]> = {
  yes: ["YES", "yes", "Yes!", "y", "yep", "yeah do it", "ok", "Okay, go ahead", "sure thanks", "do it please", "👍", "Yes, coach", "sounds good", "let's do it"],
  no: ["no", "No.", "nope", "nah", "not now", "not yet", "no thanks", "don't", "cancel", "stop", "👎", "no, maybe later"],
  unclear: [
    "", "   ", "maybe", "hmm", "yes but only $50", "yes no", "ok wait", "what if I move less?", "why?", "yes?",
    "I think so", "yes the other plan", "sure, if rent is covered", "can I do half", "lol idk", "ok don't",
    "yeah but later", "move $100 instead",
  ],
};

for (const [expected, inputs] of Object.entries(cases))
  test(`classifies as ${expected}`, () => {
    for (const text of inputs) assert.equal(classifyReply(text), expected, JSON.stringify(text));
  });

test("null and undefined are unclear", () => {
  assert.equal(classifyReply(null), "unclear");
  assert.equal(classifyReply(undefined), "unclear");
});
