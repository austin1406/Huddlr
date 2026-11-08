// ElevenLabs post-call webhook: signature check and turning the payload into a calls row + recap.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies the `ElevenLabs-Signature: t=<unix>,v0=<hex hmac-sha256 of "t.body">` header. */
export function verifySignature(rawBody: string, header: string | undefined, secret: string, nowSec = Date.now() / 1000, toleranceSec = 30 * 60): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!parts.v0 || !Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v0);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface TranscriptTurn {
  role?: string;
  message?: string | null;
  tool_calls?: { tool_name?: string; params_as_json?: string }[] | null;
  tool_results?: { tool_name?: string; result_value?: string; is_error?: boolean }[] | null;
}

export interface PostCallPayload {
  type?: string;
  data?: {
    conversation_id?: string;
    status?: string;
    transcript?: TranscriptTurn[];
    metadata?: {
      start_time_unix_secs?: number;
      call_duration_secs?: number;
      phone_call?: { external_number?: string; direction?: string } | null;
    };
    analysis?: { transcript_summary?: string | null } | null;
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> } | null;
  };
}

export interface Decision {
  proposal_id: number;
  decision: "accepted";
}

export interface ParsedCall {
  providerCallId: string;
  userPhone: string;
  direction: "inbound" | "outbound";
  startedAt: Date | null;
  durationMs: number | null;
  summary: string;
  decisions: Decision[];
  /** Every number that appeared in a tool result during the call. */
  groundedNumbers: Set<string>;
  transcript: { speaker: "user" | "coach"; text: string }[];
  /** Set for outbound calls placed from a call_requests row (passed in as a dynamic variable). */
  callRequestId: number | null;
  /** False when the user never spoke (unanswered or voicemail). */
  answered: boolean;
}

/** ElevenLabs sends this when an outbound call never connects (busy, no answer). */
export interface CallFailure {
  providerCallId: string | null;
  callRequestId: number | null;
  outcome: "no_answer" | "busy" | "failed";
}

export function parseCallFailure(payload: PostCallPayload & { data?: { failure_reason?: string } }): CallFailure | null {
  if (payload.type !== "call_initiation_failure") return null;
  const d = payload.data ?? {};
  const reason = (d.failure_reason ?? "").toLowerCase();
  const outcome = reason.includes("busy") ? "busy" : reason.includes("answer") ? "no_answer" : "failed";
  const id = Number(d.conversation_initiation_client_data?.dynamic_variables?.call_request_id);
  return { providerCallId: d.conversation_id ?? null, callRequestId: Number.isFinite(id) && id > 0 ? id : null, outcome };
}

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

/** "1,186.50" and "1186.5" both normalize to "1186.5". */
export function normalizeNumber(s: string): string {
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : s;
}

function collectNumbers(value: unknown, out: Set<string>) {
  if (typeof value === "number") out.add(String(value));
  else if (typeof value === "string") for (const m of value.match(NUMBER_RE) ?? []) out.add(normalizeNumber(m));
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, out));
}

function tryJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function parsePostCall(payload: PostCallPayload, fallbackPhone: string): ParsedCall | null {
  const d = payload.data;
  if (payload.type !== "post_call_transcription" || !d?.conversation_id) return null;

  const groundedNumbers = new Set<string>();
  const decisions: Decision[] = [];
  const transcript: ParsedCall["transcript"] = [];
  const dyn = d.conversation_initiation_client_data?.dynamic_variables ?? {};
  collectNumbers(dyn, groundedNumbers);

  for (const turn of d.transcript ?? []) {
    if (turn.message) transcript.push({ speaker: turn.role === "user" ? "user" : "coach", text: turn.message });
    for (const r of turn.tool_results ?? []) {
      const result = tryJson(r.result_value);
      collectNumbers(result, groundedNumbers);
      if (r.tool_name === "accept_proposal" && !r.is_error && result && typeof result === "object" && (result as { ok?: boolean }).ok) {
        const call = (turn.tool_calls ?? []).find((c) => c.tool_name === "accept_proposal");
        const params = tryJson(call?.params_as_json) as { proposalId?: string } | undefined;
        const id = Number(params?.proposalId);
        if (Number.isFinite(id) && !decisions.some((x) => x.proposal_id === id)) decisions.push({ proposal_id: id, decision: "accepted" });
      }
    }
  }

  const meta = d.metadata ?? {};
  const reqId = Number(dyn.call_request_id);
  return {
    callRequestId: Number.isFinite(reqId) && reqId > 0 ? reqId : null,
    answered: transcript.some((t) => t.speaker === "user"),
    providerCallId: d.conversation_id,
    userPhone: meta.phone_call?.external_number || fallbackPhone,
    direction: meta.phone_call?.direction === "outbound" ? "outbound" : "inbound",
    startedAt: meta.start_time_unix_secs ? new Date(meta.start_time_unix_secs * 1000) : null,
    durationMs: meta.call_duration_secs != null ? Math.round(meta.call_duration_secs * 1000) : null,
    summary: d.analysis?.transcript_summary?.trim() || "",
    decisions,
    groundedNumbers,
    transcript,
  };
}

/**
 * A number is grounded if a tool returned it, or it's a whole-dollar rounding of one
 * ("$437" for 437.5, the way the agent says it out loud).
 */
export function isGrounded(n: string, grounded: Set<string>): boolean {
  if (grounded.has(n)) return true;
  const x = Number(n);
  if (!Number.isInteger(x)) return false;
  for (const g of grounded) {
    const v = Number(g);
    if (Number.isFinite(v) && !Number.isInteger(v) && (Math.floor(v) === x || Math.round(v) === x)) return true;
  }
  return false;
}

/**
 * The recap text for iMessage. The LLM summary is only used if every number in it appeared in a
 * tool result during the call (the "every number comes from code" rule). Otherwise a template.
 */
export function buildRecap(call: ParsedCall): { text: string; usedSummary: boolean } {
  const decided = call.decisions.length
    ? ` You said yes to the plan, so I've marked it accepted. The transfer is yours to make in your bank.`
    : "";
  const numbers = call.summary.match(NUMBER_RE) ?? [];
  const grounded = numbers.every((n) => isGrounded(normalizeNumber(n), call.groundedNumbers));
  if (call.summary && grounded) {
    return { text: `📞 Call recap: ${call.summary}${decided}`, usedSummary: true };
  }
  return { text: `📞 Thanks for calling. I've saved our conversation here.${decided} Text me anytime to pick it back up.`, usedSummary: false };
}
