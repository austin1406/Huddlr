// Outbound calls from P2's call_requests rows: emergency (shortfall) and the optional monthly recap.
// Pure logic lives here; the database and ElevenLabs sit behind small interfaces so tests can fake them.
import type { CallRequestRow } from "../../contracts/src/agents";
import type { FactsSnapshot } from "../../contracts/src/facts";
import { isQuietHours } from "../../contracts/src/time";
import { buildDynamicVariables } from "./context";

export type CallRequest = Pick<CallRequestRow, "id" | "user_phone" | "type" | "proposal_id" | "shortfall" | "script_hint">;

export interface CallRequestStore {
  /** Atomically moves the next pending row to 'calling' (emergencies first). Null if none. */
  claimNext(opts: { includeRecap: boolean }): Promise<CallRequest | null>;
  setStatus(id: number, status: "answered" | "no_answer" | "busy" | "failed" | "cancelled"): Promise<void>;
  /** Rows stuck in 'calling' longer than this (real clock) with no webhook. */
  stale(olderThanMs: number): Promise<CallRequest[]>;
  /** Text fallback through P3's sender. Idempotent per call request. */
  queueFallbackText(req: CallRequest, text: string, simNow: Date): Promise<void>;
}

export interface Dialer {
  call(toNumber: string, dynamicVariables: Record<string, string>): Promise<{ ok: true; conversationId: string } | { ok: false; error: string }>;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const ACCOUNT_NAMES: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Car Loan", ira: "IRA" };

/** "Checking is on track to go $43.00 short on 2026-12-02." Built only from the row, which P2 built from P1's facts. */
export function shortfallSentence(req: CallRequest): string | null {
  if (!req.shortfall) return null;
  const name = ACCOUNT_NAMES[req.shortfall.account] ?? req.shortfall.account;
  return `${name} is on track to go ${usd(req.shortfall.amount_cents)} short on ${req.shortfall.date}.`;
}

export function callReason(req: CallRequest): string {
  if (req.type === "monthly_recap") {
    return req.script_hint ?? "Monthly recap call: give a short recap of the month using get_snapshot, then ask if they have questions.";
  }
  const parts = [
    "This is an EMERGENCY call you placed.",
    shortfallSentence(req),
    req.script_hint,
    "Explain the shortfall in one sentence, then read the pending proposal and ask if they will make that transfer today.",
    "Only call accept_proposal on a clear yes. Remind them they make the transfer in their own bank.",
  ];
  return parts.filter(Boolean).join(" ");
}

export function callVariables(req: CallRequest, facts: FactsSnapshot | null, goals: { label: string; target?: number; saved?: number }[]) {
  const base = buildDynamicVariables({ facts, goals, callReason: callReason(req) });
  const opener =
    req.type === "emergency"
      ? `Hi ${base.first_name}, it's the Huddlr Coach. I'm calling because ${shortfallSentence(req) ?? "something in your forecast needs a look."} Got a minute?`
      : `Hi ${base.first_name}, it's the Huddlr Coach with your monthly recap. Got two minutes?`;
  return {
    ...base,
    opener,
    call_request_id: String(req.id),
    call_type: req.type,
  };
}

export function fallbackText(req: CallRequest, outcome: "no_answer" | "busy" | "failed"): string {
  const why = outcome === "busy" ? "Your line was busy" : outcome === "failed" ? "My call didn't go through" : "I tried calling";
  if (req.type === "monthly_recap") return `📞 ${why} for your monthly recap. Text me "recap" whenever you want it.`;
  const s = shortfallSentence(req);
  return `📞 ${why}. ${s ?? "Something in your forecast needs a look."} Reply YES to the plan I sent, or text me and we'll sort it out.`;
}

export interface PollDeps {
  store: CallRequestStore;
  dialer: Dialer;
  optedIn: (phone: string) => boolean;
  loadContext: (phone: string) => Promise<{ facts: FactsSnapshot | null; goals: { label: string; target?: number; saved?: number }[] }>;
  simNow: () => Promise<Date>;
  timezone: string;
  demoMode: () => Promise<boolean>;
  log?: (msg: string) => void;
}

/** One pass: place at most one call. Returns what happened, for logs and tests. */
export async function pollOnce(deps: PollDeps): Promise<string> {
  const now = await deps.simNow();
  // Emergencies ignore quiet hours. The monthly recap waits for daytime (or demo mode).
  const includeRecap = !isQuietHours(now, deps.timezone, { demoMode: await deps.demoMode() });
  const req = await deps.store.claimNext({ includeRecap });
  if (!req) return "idle";

  if (!deps.optedIn(req.user_phone)) {
    await deps.store.setStatus(req.id, "cancelled");
    return `cancelled ${req.id}: ${req.user_phone} has not opted in to calls`;
  }

  const { facts, goals } = await deps.loadContext(req.user_phone);
  const result = await deps.dialer.call(req.user_phone, callVariables(req, facts, goals));
  if (!result.ok) {
    await deps.store.setStatus(req.id, "failed");
    await deps.store.queueFallbackText(req, fallbackText(req, "failed"), now);
    return `failed ${req.id}: ${result.error}`;
  }
  return `calling ${req.id}: conversation ${result.conversationId}`;
}

/** Calls that never produced a webhook (process restart, provider hiccup) become no-answer + text. */
export async function sweepStale(deps: Pick<PollDeps, "store" | "simNow">, olderThanMs: number): Promise<number> {
  const stuck = await deps.store.stale(olderThanMs);
  const now = await deps.simNow();
  for (const req of stuck) {
    await deps.store.setStatus(req.id, "no_answer");
    await deps.store.queueFallbackText(req, fallbackText(req, "no_answer"), now);
  }
  return stuck.length;
}
