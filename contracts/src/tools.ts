import { z } from "zod";
import { DateBalance, isoDate, money } from "./common";
import { EventsResponse } from "./events";
import { FactsSnapshot, ProposalStatus, ProposalSummary } from "./facts";
import { Plan } from "./plan";
import { Scenario, WhatIfResult } from "./scenarios";

/** Every tool call must send this header with the shared secret (VOICE_TOOL_SECRET). */
export const TOOL_AUTH_HEADER = "x-tool-secret";

export const ToolName = z.enum([
  "get_snapshot",
  "can_i_afford",
  "what_if",
  "get_plan",
  "get_pending_proposal",
  "accept_proposal",
]);
export type ToolName = z.infer<typeof ToolName>;

/** Finance service endpoints. Tools are POST with a JSON body. */
export const ENDPOINTS = {
  facts: { method: "GET", path: "/facts" },
  events: { method: "GET", path: "/events" },
  health: { method: "GET", path: "/health" },
  tools: {
    get_snapshot: { method: "POST", path: "/tools/get_snapshot" },
    can_i_afford: { method: "POST", path: "/tools/can_i_afford" },
    what_if: { method: "POST", path: "/tools/what_if" },
    get_plan: { method: "POST", path: "/tools/get_plan" },
    get_pending_proposal: { method: "POST", path: "/tools/get_pending_proposal" },
    accept_proposal: { method: "POST", path: "/tools/accept_proposal" },
  },
} as const;

/** GET /events?after=<eventId>&limit=50 returns events newer than `after`, oldest first. */
export const EventsQuery = z.object({
  after: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type EventsQuery = z.infer<typeof EventsQuery>;
export { EventsResponse };

export const GetSnapshotRequest = z.object({});
export const GetSnapshotResponse = FactsSnapshot;

export const CanIAffordRequest = z.object({ amount: money.positive(), label: z.string().optional() });
export type CanIAffordRequest = z.infer<typeof CanIAffordRequest>;
/**
 * verdict: "yes" if the lowest balance after the purchase stays at or above the cushion,
 * "tight" if it stays at or above zero but below the cushion, "no" if it goes negative.
 */
export const CanIAffordResponse = z.object({
  amount: money,
  verdict: z.enum(["yes", "tight", "no"]),
  safeToSpendUntilPayday: money,
  lowestBalanceAfter: DateBalance,
  firstNegativeDateAfter: isoDate.nullable(),
  cushion: money,
});
export type CanIAffordResponse = z.infer<typeof CanIAffordResponse>;

export const WhatIfRequest = z.object({ scenario: Scenario });
export type WhatIfRequest = z.infer<typeof WhatIfRequest>;
export const WhatIfResponse = WhatIfResult;

export const GetPlanRequest = z.object({
  amount: money.positive(),
  source: z.enum(["bonus", "surplus", "other"]).optional(),
});
export type GetPlanRequest = z.infer<typeof GetPlanRequest>;
export const GetPlanResponse = Plan;

export const GetPendingProposalRequest = z.object({});
export const GetPendingProposalResponse = z.object({ proposal: ProposalSummary.nullable() });
export type GetPendingProposalResponse = z.infer<typeof GetPendingProposalResponse>;

/**
 * accept_proposal is a thin wrapper: the finance service forwards to the agents service's
 * ProposalService, which owns every rule (duplicates, expiry, "unclear means no").
 * Voice must only call it after a clearly spoken yes.
 */
export const AcceptProposalRequest = z.object({
  proposalId: z.string(),
  via: z.enum(["text", "voice"]),
});
export type AcceptProposalRequest = z.infer<typeof AcceptProposalRequest>;
export const AcceptProposalResponse = z.object({
  ok: z.boolean(),
  status: ProposalStatus,
  message: z.string().optional(),
});
export type AcceptProposalResponse = z.infer<typeof AcceptProposalResponse>;
