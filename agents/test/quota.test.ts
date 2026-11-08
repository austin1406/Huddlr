import { test } from "node:test";
import assert from "node:assert/strict";
import { nextDailyReset, parseQuotaError, QuotaTracker } from "../src/quota";

// Shape of a real Gemini 429 (google.rpc QuotaFailure + RetryInfo).
const body = (quotaId: string, retry = "37s") =>
  JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: retry },
      ],
    },
  });

test("tells per-minute from daily limits, and reads the retry delay", () => {
  const m = parseQuotaError(body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "12s"));
  assert.deepEqual([m.scope, m.retryAfterSeconds], ["minute", 12]);
  const d = parseQuotaError(body("GenerateRequestsPerDayPerProjectPerModel-FreeTier"));
  assert.equal(d.scope, "day");
  assert.equal(parseQuotaError("not json").scope, "unknown");
});

test("tracker logs once when the limit hits and once when it clears", () => {
  let t = Date.parse("2026-11-07T20:00:00Z");
  const lines: string[] = [];
  const q = new QuotaTracker((l) => lines.push(l), () => t);
  q.record(parseQuotaError(body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "30s")));
  q.record(parseQuotaError(body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "30s")));
  assert.equal(lines.length, 1, "no log spam while already limited");
  assert.equal(q.limited(), true);
  assert.equal(q.status().scope, "minute");
  t += 31_000;
  assert.equal(q.limited(), false);
  q.ok();
  assert.match(lines.at(-1)!, /answering again/);
});

test("daily limit holds until midnight Pacific", () => {
  const t = Date.parse("2026-11-07T20:00:00Z"); // noon Pacific (PST)
  const q = new QuotaTracker(() => {}, () => t);
  q.record(parseQuotaError(body("GenerateRequestsPerDayPerProjectPerModel-FreeTier")));
  assert.equal(q.status().limitedUntil, "2026-11-08T08:00:00.000Z");
  assert.equal(nextDailyReset(new Date(t)).toISOString(), "2026-11-08T08:00:00.000Z");
});
