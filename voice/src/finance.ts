import { ENDPOINTS, TOOL_AUTH_HEADER } from "../../contracts/src/tools";
import type { FactsSnapshot } from "../../contracts/src/facts";
import { env } from "./env";

/** GET /facts from P1. Returns null (and the call goes on without context) if it is down or slow. */
export async function fetchFacts(timeoutMs = 2500): Promise<FactsSnapshot | null> {
  if (!env.financeUrl) return null;
  try {
    const res = await fetch(`${env.financeUrl}${ENDPOINTS.facts.path}`, {
      headers: { [TOOL_AUTH_HEADER]: env.huddlrSecret },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as FactsSnapshot;
  } catch {
    return null;
  }
}
