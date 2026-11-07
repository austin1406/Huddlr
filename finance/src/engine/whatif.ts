import { localDate, type Persona, type Scenario, type WhatIfResult } from "../../../contracts/src";
import { addDays, daysBetween } from "./calendar";
import { buildForecast, buildIndicators, forecastDays, type ForecastMods } from "./facts";
import { postPurchase, type LedgerState } from "./ledger";

/**
 * Runs a scenario against a copy of the ledger and compares it with the real forecast and indicators.
 * - purchase_now: spends from checking today.
 * - one_time_expense: an outflow on that date.
 * - new_recurring: a monthly bill on that day of the month.
 * - lose_income: no paychecks for `months` x 30 days; the savings rate becomes -100 percent.
 */
export function whatIf(state: LedgerState, persona: Persona, now: Date, scenario: Scenario): WhatIfResult {
  const today = localDate(now, persona.customer.timezone);
  const copy = structuredClone(state);
  const mods: ForecastMods = {};
  let income30: number | undefined;

  switch (scenario.type) {
    case "purchase_now":
      postPurchase(copy, today, now.toISOString(), { amount: scenario.amount, merchant: scenario.label ?? "What-if purchase" });
      break;
    case "one_time_expense":
      mods.extraOutflows = [{ date: scenario.date, amount: scenario.amount }];
      break;
    case "new_recurring":
      mods.extraRecurring = [{ dayOfMonth: scenario.dayOfMonth, amount: scenario.amount }];
      break;
    case "lose_income":
      mods.noPaychecksThrough = addDays(today, scenario.months * 30);
      income30 = 0;
      break;
  }

  const before = buildForecast(state, persona, today);
  const afterDays = forecastDays(copy, persona, today, mods);
  const after = buildForecast(copy, persona, today, afterDays);
  const beforeIndicators = buildIndicators(state, persona, today);
  const afterIndicators = buildIndicators(copy, persona, today, { income30 });
  const runway = (list: typeof beforeIndicators) => list.find((i) => i.id === "runway")?.value ?? 0;
  const statuses = (list: typeof beforeIndicators) => Object.fromEntries(list.map((i) => [i.id, i.status]));

  return {
    schemaVersion: 1,
    scenario,
    before: { lowestBalance: before.lowest, firstNegativeDate: before.firstNegativeDate, runwayMonths: runway(beforeIndicators), indicatorStatuses: statuses(beforeIndicators) },
    after: { lowestBalance: after.lowest, firstNegativeDate: after.firstNegativeDate, runwayMonths: runway(afterIndicators), indicatorStatuses: statuses(afterIndicators) },
    changedIndicators: afterIndicators.flatMap((a) => {
      const b = beforeIndicators.find((i) => i.id === a.id);
      return b && b.status !== a.status ? [{ id: a.id, from: b.status, to: a.status }] : [];
    }),
    daysUntilNegative: after.firstNegativeDate ? daysBetween(today, after.firstNegativeDate) : null,
  };
}
