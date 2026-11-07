import type { FactsSnapshot, Plan, PlanLine } from "../../../contracts/src";
import { r2 } from "./afford";

const HIGH_INTEREST_APR_PERCENT = 8;

/**
 * Plan v0: cover any shortfall (plus the cushion), then pay down the highest-APR debt above 8%,
 * then build the emergency fund up to one month of essentials. Anything left is unallocated.
 * Optimizer v1 (employer match, goals, 3-month fund, preferences) returns the same shape.
 */
export function planV0(facts: FactsSnapshot, amount: number): Plan {
  const lines: PlanLine[] = [];
  let remaining = r2(amount);
  let shortfallCovered = 0;

  if (facts.shortfall && remaining > 0) {
    const need = facts.shortfall.suggestedTransfer;
    const put = r2(Math.min(remaining, need));
    lines.push({
      destination: "checking",
      amount: put,
      reasonCode: "cover_shortfall",
      reasonNumbers: {
        shortfallAmount: facts.shortfall.amount,
        cushion: facts.forecast.cushion,
        neededWithCushion: need,
      },
    });
    shortfallCovered = put;
    remaining = r2(remaining - put);
  }

  const debts = facts.accounts
    .filter((a) => (a.kind === "credit_card" || a.kind === "car_loan") && (a.aprPercent ?? 0) > HIGH_INTEREST_APR_PERCENT && a.balance > 0)
    .sort((a, b) => (b.aprPercent ?? 0) - (a.aprPercent ?? 0));
  for (const debt of debts) {
    if (remaining <= 0) break;
    const apr = debt.aprPercent ?? 0;
    const put = r2(Math.min(remaining, debt.balance));
    lines.push({
      destination: debt.id,
      amount: put,
      reasonCode: "pay_high_interest_debt",
      reasonNumbers: {
        aprPercent: apr,
        balanceBefore: debt.balance,
        balanceAfter: r2(debt.balance - put),
        monthlyInterestSaved: r2((put * apr) / 100 / 12),
      },
    });
    remaining = r2(remaining - put);
  }

  const runway = facts.indicators.find((i) => i.id === "runway");
  const savings = facts.accounts.find((a) => a.id === "savings");
  const monthlyEssentials = runway?.inputs.monthlyEssentials ?? 0;
  if (remaining > 0 && savings && monthlyEssentials > 0) {
    const need = r2(monthlyEssentials - savings.balance);
    if (need > 0) {
      const put = r2(Math.min(remaining, need));
      lines.push({
        destination: "savings",
        amount: put,
        reasonCode: "build_emergency_fund",
        reasonNumbers: {
          runwayMonthsBefore: r2(savings.balance / monthlyEssentials),
          runwayMonthsAfter: r2((savings.balance + put) / monthlyEssentials),
          targetMonths: 1,
        },
      });
      remaining = r2(remaining - put);
    }
  }

  return {
    schemaVersion: 1,
    asOf: facts.asOf,
    amount: r2(amount),
    shortfallCovered,
    unallocated: remaining,
    lines,
  };
}
