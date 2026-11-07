import type { FactsSnapshot, Scenario, WhatIfResult } from "../../../contracts/src";
import { canIAfford } from "./afford";

function daysBetween(a: string, b: string): number {
  const ms = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/**
 * purchase_now is computed from the forecast. The other scenarios return the fixture result with the
 * requested scenario echoed back (shape only) until the real simulator lands.
 */
export function whatIf(facts: FactsSnapshot, scenario: Scenario, fixture: WhatIfResult): WhatIfResult {
  if (scenario.type !== "purchase_now") return { ...fixture, scenario };

  const fc = facts.forecast;
  const runway = facts.indicators.find((i) => i.id === "runway");
  const statuses = Object.fromEntries(facts.indicators.map((i) => [i.id, i.status]));
  const after = canIAfford(facts, scenario.amount);
  return {
    schemaVersion: 1,
    scenario,
    before: {
      lowestBalance: fc.lowest,
      firstNegativeDate: fc.firstNegativeDate,
      runwayMonths: runway?.value ?? 0,
      indicatorStatuses: statuses,
    },
    after: {
      lowestBalance: after.lowestBalanceAfter,
      firstNegativeDate: after.firstNegativeDateAfter,
      runwayMonths: runway?.value ?? 0,
      indicatorStatuses: statuses,
    },
    changedIndicators: [],
    daysUntilNegative: after.firstNegativeDateAfter ? daysBetween(facts.localDate, after.firstNegativeDateAfter) : null,
  };
}
