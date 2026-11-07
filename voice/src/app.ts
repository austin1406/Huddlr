import { Hono } from "hono";
import { TOOL_AUTH_HEADER } from "../../contracts/src/tools";
import { buildDynamicVariables, initiationResponse } from "./context";
import { env } from "./env";
import { fetchFacts } from "./finance";
import { loadGoals, recordCallFailure, saveCall } from "./db";
import { buildRecap, parseCallFailure, parsePostCall, verifySignature, type PostCallPayload } from "./postCall";

export const app = new Hono();

app.get("/voice/health", (c) => c.json({ ok: true }));

// ElevenLabs conversation-initiation webhook: fills the prompt's {{variables}} at call start.
// Outbound calls already carry their variables, so this only matters for inbound calls.
app.post("/voice/context", async (c) => {
  if (env.huddlrSecret && c.req.header(TOOL_AUTH_HEADER) !== env.huddlrSecret) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { caller_id?: string };
  const phone = body.caller_id || env.demoUserPhone;
  const [facts, goals] = await Promise.all([fetchFacts(), loadGoals(phone)]);
  return c.json(initiationResponse(buildDynamicVariables({ facts, goals })));
});

// ElevenLabs post-call webhook: save the call and queue a recap (or a text fallback) for P3's sender.
app.post("/voice/post-call", async (c) => {
  const raw = await c.req.text();
  if (!verifySignature(raw, c.req.header("elevenlabs-signature"), env.elevenLabsWebhookSecret)) {
    return c.json({ error: "bad signature" }, 401);
  }
  const payload = JSON.parse(raw) as PostCallPayload;

  const failure = parseCallFailure(payload);
  if (failure) {
    const handled = failure.callRequestId != null && (await recordCallFailure(failure.callRequestId, failure.outcome));
    return c.json({ ok: true, failure: failure.outcome, handled });
  }

  const call = parsePostCall(payload, env.demoUserPhone);
  if (!call) return c.json({ ok: true, ignored: payload.type ?? "unknown" });
  const recap = buildRecap(call);
  const result = await saveCall(call, recap.text);
  return c.json({ ok: true, ...result, answered: call.answered, usedSummary: recap.usedSummary, decisions: call.decisions.length });
});
