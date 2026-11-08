import { MemorySimStateStore, ProjectionResponse } from "../../../contracts/src";
import { PERSONA } from "../../src/data/config";
import { EngineBackend } from "../../src/engine/backend";
import { NoProposals } from "../../src/proposals";

/** The windows the dashboard offers as presets. Keys are what its sample mode looks up. */
export const PRESETS = [
  { key: "1m", amount: 1, unit: "months" },
  { key: "6m", amount: 6, unit: "months" },
  { key: "1y", amount: 1, unit: "years" },
  { key: "5y", amount: 5, unit: "years" },
  { key: "10y", amount: 10, unit: "years" },
] as const;

/** Maya on 2026-11-07 (the facts fixture's day), each preset with the Coach comparison. */
export async function buildProjectionFixture(): Promise<Record<string, unknown>> {
  const T0 = Date.parse("2026-11-07T16:00:00.000Z");
  const backend = await EngineBackend.create({
    persona: PERSONA,
    store: new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: new Date(T0).toISOString() }),
    gateway: new NoProposals(),
    realNow: () => T0,
  });
  const out: Record<string, unknown> = {};
  for (const p of PRESETS) {
    const r = await backend.project({ amount: p.amount, unit: p.unit, compare: true });
    out[p.key] = ProjectionResponse.parse(JSON.parse(JSON.stringify(r)));
  }
  return out;
}
