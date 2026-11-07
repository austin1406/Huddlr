import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FactsSnapshot } from "../../contracts/src/facts";
import { buildDynamicVariables } from "../src/context";
import { buildRecap, parsePostCall, verifySignature, type PostCallPayload } from "../src/postCall";
import { buildTools, TOOL_NAMES } from "../src/tools";

const fixture = (name: string) =>
  FactsSnapshot.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../../contracts/fixtures/${name}`, import.meta.url)), "utf8")));

const sign = (body: string, secret: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

function payload(opts: { summary: string; toolResult?: object; accept?: boolean }): PostCallPayload {
  return {
    type: "post_call_transcription",
    data: {
      conversation_id: "conv_123",
      metadata: { start_time_unix_secs: 1_794_000_000, call_duration_secs: 42, phone_call: { external_number: "+12145550123", direction: "inbound" } },
      analysis: { transcript_summary: opts.summary },
      transcript: [
        { role: "user", message: "Can I afford a $40 dinner tonight?" },
        {
          role: "agent",
          message: null,
          tool_calls: [{ tool_name: "can_i_afford", params_as_json: '{"amount":40}' }],
          tool_results: [{ tool_name: "can_i_afford", result_value: JSON.stringify(opts.toolResult ?? { amount: 40, verdict: "yes", safeToSpendUntilPayday: 212.5 }) }],
        },
        { role: "agent", message: "Yes, you've got about two hundred twelve dollars to spend until payday." },
        ...(opts.accept
          ? [{
              role: "agent",
              message: null,
              tool_calls: [{ tool_name: "accept_proposal", params_as_json: '{"proposalId":"7","via":"voice"}' }],
              tool_results: [{ tool_name: "accept_proposal", result_value: '{"ok":true,"status":"accepted"}' }],
            }]
          : []),
      ],
    },
  };
}

test("dynamic variables come from the facts snapshot", () => {
  const facts = fixture("facts.fixture.json");
  const v = buildDynamicVariables({ facts, goals: [{ label: "Trip fund", target: 1500, saved: 300 }] });
  assert.equal(v.first_name, facts.customer.firstName);
  assert.equal(v.local_date, facts.localDate);
  assert.equal(v.goals, "Trip fund: $300.00 of $1500.00");
});

test("dynamic variables survive the finance service being down", () => {
  const v = buildDynamicVariables({ facts: null, goals: [] });
  assert.equal(v.first_name, "there");
  assert.equal(v.pending_proposal, "none");
});

test("signature: accepts a valid one, rejects tampered, stale, or missing", () => {
  const body = '{"type":"post_call_transcription"}';
  assert.ok(verifySignature(body, sign(body, "s3cret"), "s3cret"));
  assert.ok(!verifySignature(body + " ", sign(body, "s3cret"), "s3cret"));
  assert.ok(!verifySignature(body, sign(body, "wrong"), "s3cret"));
  assert.ok(!verifySignature(body, sign(body, "s3cret", Math.floor(Date.now() / 1000) - 3600), "s3cret"));
  assert.ok(!verifySignature(body, undefined, "s3cret"));
  assert.ok(!verifySignature(body, sign(body, "s3cret"), ""));
});

test("parses the call and picks up a successful accept_proposal", () => {
  const call = parsePostCall(payload({ summary: "x", accept: true }), "+10000000000")!;
  assert.equal(call.providerCallId, "conv_123");
  assert.equal(call.userPhone, "+12145550123");
  assert.equal(call.durationMs, 42_000);
  assert.deepEqual(call.decisions, [{ proposal_id: 7, decision: "accepted" }]);
  assert.equal(call.transcript.length, 2);
});

test("ignores other webhook types", () => {
  assert.equal(parsePostCall({ type: "post_call_audio", data: { conversation_id: "c" } }, ""), null);
});

test("recap uses the summary only when every number in it came from a tool", () => {
  const ok = buildRecap(parsePostCall(payload({ summary: "Maya asked about a $40 dinner; $212.50 is safe to spend." }), "")!);
  assert.equal(ok.usedSummary, true);
  assert.match(ok.text, /\$212\.50/);

  const invented = buildRecap(parsePostCall(payload({ summary: "Maya has $999 left." }), "")!);
  assert.equal(invented.usedSummary, false);
  assert.doesNotMatch(invented.text, /999/);
});

test("recap mentions an accepted proposal without claiming money moved", () => {
  const r = buildRecap(parsePostCall(payload({ summary: "", accept: true }), "")!);
  assert.match(r.text, /accepted/);
  assert.match(r.text, /yours to make/);
});

test("tools point at P1's endpoints with the shared secret header", () => {
  const tools = buildTools("https://huddlr.example", "abc");
  assert.equal(tools.length, TOOL_NAMES.length);
  const afford = tools.find((t) => t.name === "can_i_afford")!;
  assert.equal(afford.api_schema.url, "https://huddlr.example/tools/can_i_afford");
  assert.equal(afford.api_schema.request_headers["x-huddlr-secret"], "abc");
});
