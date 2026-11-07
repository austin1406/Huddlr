import { test } from "node:test";
import assert from "node:assert/strict";
import { callVariables, fallbackText, pollOnce, sweepStale, type CallRequest, type CallRequestStore, type PollDeps } from "../src/outbound";
import { parseCallFailure, parsePostCall } from "../src/postCall";

const emergency: CallRequest = {
  id: 11,
  user_phone: "+12145550123",
  type: "emergency",
  proposal_id: 7,
  shortfall: { amount_cents: 4300, date: "2026-12-02", account: "checking" },
  script_hint: null,
};
const recap: CallRequest = { ...emergency, id: 12, type: "monthly_recap", proposal_id: null, shortfall: null };

function fakeStore(rows: CallRequest[]) {
  const log: string[] = [];
  const texts: { id: number; text: string }[] = [];
  const store: CallRequestStore = {
    async claimNext({ includeRecap }) {
      const i = rows.findIndex((r) => r.type === "emergency" || includeRecap);
      return i < 0 ? null : rows.splice(i, 1)[0];
    },
    async setStatus(id, status) {
      log.push(`${id}:${status}`);
    },
    async stale() {
      return [emergency];
    },
    async queueFallbackText(req, text) {
      texts.push({ id: req.id, text });
    },
  };
  return { store, log, texts };
}

function deps(store: CallRequestStore, over: Partial<PollDeps> = {}): PollDeps & { dialed: Record<string, string>[] } {
  const dialed: Record<string, string>[] = [];
  return {
    dialed,
    store,
    dialer: { async call(_to, vars) { dialed.push(vars); return { ok: true, conversationId: "conv_out" }; } },
    optedIn: (p) => p === "+12145550123",
    loadContext: async () => ({ facts: null, goals: [] }),
    // 23:00 in Chicago: quiet hours.
    simNow: async () => new Date("2026-12-01T05:00:00Z"),
    demoMode: async () => false,
    timezone: "America/Chicago",
    ...over,
  };
}

test("emergency calls go out during quiet hours and carry the shortfall from the row", async () => {
  const { store } = fakeStore([emergency]);
  const d = deps(store);
  assert.match(await pollOnce(d), /^calling 11/);
  assert.equal(d.dialed[0].call_request_id, "11");
  assert.match(d.dialed[0].call_reason, /Checking is on track to go \$43\.00 short on 2026-12-02/);
});

test("monthly recap waits out quiet hours, then goes in daytime or demo mode", async () => {
  const { store } = fakeStore([recap]);
  assert.equal(await pollOnce(deps(store)), "idle");
  assert.match(await pollOnce(deps(store, { demoMode: async () => true })), /^calling 12/);
});

test("numbers that haven't opted in are never called", async () => {
  const { store, log } = fakeStore([{ ...emergency, user_phone: "+19995550000" }]);
  const d = deps(store);
  assert.match(await pollOnce(d), /^cancelled 11/);
  assert.deepEqual(log, ["11:cancelled"]);
  assert.equal(d.dialed.length, 0);
});

test("a failed dial marks the request failed and texts instead", async () => {
  const { store, log, texts } = fakeStore([emergency]);
  const d = deps(store, { dialer: { async call() { return { ok: false, error: "SIP 403" }; } } });
  assert.match(await pollOnce(d), /^failed 11: SIP 403/);
  assert.deepEqual(log, ["11:failed"]);
  assert.match(texts[0].text, /didn't go through.*\$43\.00 short on 2026-12-02/);
});

test("stale calling rows become no_answer with a text", async () => {
  const { store, log, texts } = fakeStore([]);
  assert.equal(await sweepStale(deps(store), 1000), 1);
  assert.deepEqual(log, ["11:no_answer"]);
  assert.match(texts[0].text, /I tried calling/);
});

test("fallback texts only use numbers from the row", () => {
  assert.equal(
    fallbackText(emergency, "busy"),
    "📞 Your line was busy. Checking is on track to go $43.00 short on 2026-12-02. Reply YES to the plan I sent, or text me and we'll sort it out.",
  );
  assert.doesNotMatch(fallbackText(recap, "no_answer"), /\$/);
});

test("call variables include the request id so the webhook can link back", () => {
  const v = callVariables(emergency, null, []);
  assert.equal(v.call_request_id, "11");
  assert.equal(v.call_type, "emergency");
  assert.equal(v.opener, "Hi there, it's the Huddlr Coach. I'm calling because Checking is on track to go $43.00 short on 2026-12-02. Got a minute?");
});

test("post-call: links the request and treats no user speech as unanswered", () => {
  const call = parsePostCall(
    {
      type: "post_call_transcription",
      data: {
        conversation_id: "conv_out",
        transcript: [{ role: "agent", message: "Hi Maya, it's the Coach." }],
        conversation_initiation_client_data: { dynamic_variables: { call_request_id: "11" } },
      },
    },
    "+12145550123",
  )!;
  assert.equal(call.callRequestId, 11);
  assert.equal(call.answered, false);
});

test("call_initiation_failure maps busy and no-answer", () => {
  const busy = parseCallFailure({
    type: "call_initiation_failure",
    data: { conversation_id: "c1", failure_reason: "busy", conversation_initiation_client_data: { dynamic_variables: { call_request_id: "11" } } },
  } as never);
  assert.deepEqual(busy, { providerCallId: "c1", callRequestId: 11, outcome: "busy" });
  const none = parseCallFailure({ type: "call_initiation_failure", data: { failure_reason: "no-answer" } } as never);
  assert.equal(none?.outcome, "no_answer");
  assert.equal(none?.callRequestId, null);
});
