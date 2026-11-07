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
    const label = typeof e.data.label === "string" ? ` ${e.data.label}` : "";
    return `${e.type.replace(/_/g, " ")}${label}${amount}`;
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

/** Response body ElevenLabs expects from the conversation-initiation webhook. */
export function initiationResponse(dynamic_variables: Record<string, string>) {
  return { type: "conversation_initiation_client_data", dynamic_variables };
}
