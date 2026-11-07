import type { CanIAffordResponse, FactsSnapshot } from "../../../contracts/src";

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A purchase today lowers every balance in the forecast by the same amount, so the lowest point
 * drops by `amount` and the first negative day is the first day whose balance minus `amount` is negative.
 * verdict: "yes" at or above the cushion, "tight" at or above zero, otherwise "no".
 * safeToSpendUntilPayday is the figure before this purchase.
 */
export function canIAfford(facts: FactsSnapshot, amount: number): CanIAffordResponse {
  const fc = facts.forecast;
  const lowestBalance = r2(fc.lowest.balance - amount);
  const firstNegativeDateAfter = fc.days.find((d) => r2(d.balance - amount) < 0)?.date ?? null;
  const verdict = lowestBalance >= fc.cushion ? "yes" : lowestBalance >= 0 ? "tight" : "no";
  return {
    amount: r2(amount),
    verdict,
    safeToSpendUntilPayday: fc.safeToSpendUntilPayday,
    lowestBalanceAfter: { date: fc.lowest.date, balance: lowestBalance },
    firstNegativeDateAfter,
    cushion: fc.cushion,
  };
}
