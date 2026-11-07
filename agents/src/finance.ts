// Client for P1's finance service (/facts, /events, /tools/*). Every number the agents use comes from here.
import { ENDPOINTS, EventsResponse, FactsSnapshot, Plan, TOOL_AUTH_HEADER, type FinanceEvent } from "../../contracts/src";

export interface Finance {
  facts(): Promise<FactsSnapshot>;
  events(after?: string): Promise<FinanceEvent[]>;
  plan(amount: number): Promise<Plan>;
}

/** Real-clock timeouts: these are delivery mechanics, not calendar logic. fetchImpl lets tests talk to P1's app in-process. */
export function financeClient(baseUrl: string, secret: string, timeoutMs = 4000, fetchImpl: typeof fetch = fetch): Finance {
  const base = baseUrl.replace(/\/$/, "");
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetchImpl(base + path, {
      method,
      headers: { "content-type": "application/json", ...(secret ? { [TOOL_AUTH_HEADER]: secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`finance ${method} ${path}: ${res.status}`);
    return res.json();
  };
  return {
    facts: async () => FactsSnapshot.parse(await call("GET", ENDPOINTS.facts.path)),
    events: async (after) =>
      EventsResponse.parse(await call("GET", `${ENDPOINTS.events.path}?limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`)).events,
    plan: async (amount) => Plan.parse(await call("POST", ENDPOINTS.tools.get_plan.path, { amount })),
  };
}
