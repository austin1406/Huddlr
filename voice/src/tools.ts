// ElevenLabs "webhook" tool definitions for the voice agent, pointing at P1's finance endpoints.
import { ENDPOINTS, TOOL_AUTH_HEADER, type ToolName } from "../../contracts/src/tools";

interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

const TOOL_SPECS: Record<ToolName, { description: string; body: JsonSchema }> = {
  get_snapshot: {
    description: "Current balances, upcoming bills and paychecks, forecast, health indicators, and pending proposals.",
    body: { type: "object", properties: {} },
  },
  can_i_afford: {
    description: "Checks whether a purchase fits. Returns verdict yes, tight, or no, plus safe-to-spend until payday.",
    body: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Purchase amount in dollars, e.g. 40" },
        label: { type: "string", description: "What it's for, e.g. dinner" },
      },
      required: ["amount"],
    },
  },
  what_if: {
    description: "Simulates a scenario: purchase_now, lose_income, one_time_expense, or new_recurring.",
    body: {
      type: "object",
      properties: {
        scenario: {
          type: "object",
          description:
            "purchase_now: amount. lose_income: months. one_time_expense: amount and date (YYYY-MM-DD). new_recurring: amount, dayOfMonth (1-28), label.",
          properties: {
            type: { type: "string", enum: ["purchase_now", "lose_income", "one_time_expense", "new_recurring"] },
            amount: { type: "number", description: "Dollars" },
            months: { type: "integer", description: "lose_income only" },
            date: { type: "string", description: "one_time_expense only, YYYY-MM-DD" },
            dayOfMonth: { type: "integer", description: "new_recurring only, 1-28" },
            label: { type: "string" },
          },
          required: ["type"],
        },
      },
      required: ["scenario"],
    },
  },
  get_plan: {
    description: "How to split an amount of money (bonus or surplus) across accounts, with reasons.",
    body: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Dollars to allocate" },
        source: { type: "string", enum: ["bonus", "surplus", "other"] },
      },
      required: ["amount"],
    },
  },
  get_pending_proposal: {
    description: "The one suggestion currently waiting for the caller's yes or no, or null.",
    body: { type: "object", properties: {} },
  },
  accept_proposal: {
    description: "Records the caller's clear spoken yes to the pending proposal. Never call on an unclear answer.",
    body: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "id from get_pending_proposal" },
        via: { type: "string", enum: ["voice"] },
      },
      required: ["proposalId", "via"],
    },
  },
};

export function buildTools(baseUrl: string, secret: string) {
  return (Object.keys(TOOL_SPECS) as ToolName[]).map((name) => ({
    type: "webhook" as const,
    name,
    description: TOOL_SPECS[name].description,
    api_schema: {
      url: `${baseUrl}${ENDPOINTS.tools[name].path}`,
      method: ENDPOINTS.tools[name].method,
      request_headers: { [TOOL_AUTH_HEADER]: secret },
      request_body_schema: TOOL_SPECS[name].body,
    },
  }));
}

export const TOOL_NAMES = Object.keys(TOOL_SPECS) as ToolName[];
