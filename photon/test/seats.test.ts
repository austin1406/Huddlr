import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHandle } from "../src/seats.js";

test("phone numbers in any common format become E.164", () => {
  assert.equal(normalizeHandle("4695551234"), "+14695551234");
  assert.equal(normalizeHandle("(469) 555-1234"), "+14695551234");
  assert.equal(normalizeHandle("+1 469 555 1234"), "+14695551234");
  assert.equal(normalizeHandle("14695551234"), "+14695551234");
  assert.equal(normalizeHandle("+44 7700 900123"), "+447700900123");
  assert.equal(normalizeHandle("Judge@Example.com"), "judge@example.com");
  assert.throws(() => normalizeHandle("555-1234"));
});
