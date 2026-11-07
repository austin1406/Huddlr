// Builds the ElevenLabs dynamic variables for the start of a call from P1's facts snapshot.
// Every number here comes from code (the snapshot), so the agent may quote it.
import type { FactsSnapshot } from "../../contracts/src/facts";

export interface CallStartInput {
  facts: FactsSnapshot | null;
  goals: { label: string; target?: number; saved?: number }[];
  callReason?: string;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function buildDynamicVariables({ facts, goals, callReason }: CallStartInput): Record<string, string> {
  const pending = facts?.pendingProposals.find((p) => p.status === "pending");
  const events = (facts?.recentEvents ?? []).slice(-3).map((e) => {
    const amount = typeof e.data.amount === "number" ? ` ${usd(e.data.amount)}` : "";
    const what = [e.data.label, e.data.merchant, e.data.billId].find((v) => typeof v === "string");
    const label = what ? ` ${what}` : "";
    const when = typeof e.data.dueDate === "string" ? ` due ${e.data.dueDate}` : typeof e.data.firstNegativeDate === "string" ? ` on ${e.data.firstNegativeDate}` : "";
    return `${e.type.replace(/_/g, " ")}${label}${amount}${when}`;
  });
  const firstName = facts?.customer.firstName ?? "there";
  return {
    opener: `Hey ${firstName}, it's the Huddlr Coach. What can I help you with?`,
    first_name: firstName,
    local_date: facts?.localDate ?? "unknown",
    pending_proposal: pending ? `${pending.actionText} (id ${pending.id}, ${usd(pending.amount)})` : "none",
    recent_events: events.length ? events.join("; ") : "none",
    goals: goals.length
      ? goals
          .map((g) => (g.target != null && g.saved != null ? `${g.label}: ${usd(g.saved)} of ${usd(g.target)}` : g.label))
          .join("; ")
      : "none",
    call_reason: callReason ?? "the caller called in",
  };
}

/** Whether an inbound caller is on the demo allowlist. Empty list or "*" lets everyone through. */
export function isAllowedCaller(callerId: string | undefined, allowed: string[]): boolean {
  if (!allowed.length || allowed.includes("*")) return true;
  return !!callerId && allowed.includes(callerId);
}

/** Variables for a caller who isn't on the allowlist: no names, no numbers. */
export function unknownCallerVariables(): Record<string, string> {
  return {
    opener: "Hi, this is the Huddlr Coach. This line is set up for the account owner's phone, so I can't share account details on this call.",
    first_name: "there",
    local_date: "unknown",
    pending_proposal: "none",
    recent_events: "none",
    goals: "none",
    call_reason:
      "UNKNOWN CALLER. Do not call any tools and do not share any names, balances, or account details. Politely explain the line only works from the owner's phone, offer general money tips if asked, and end the call.",
  };
}

/** Response body ElevenLabs expects from the conversation-initiation webhook. */
export function initiationResponse(dynamic_variables: Record<string, string>) {
  return { type: "conversation_initiation_client_data", dynamic_variables };
}
