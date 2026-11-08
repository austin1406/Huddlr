import type { FactsSnapshot, Persona, Plan, PlanLine } from "../../../contracts/src";
import { THRESHOLDS } from "../data/config";
import { r2 } from "./calendar";

export type PlanVersion = "v0" | "v1";

type Goal = Persona["goals"][number];

/**
 * Optimizer v1: where a sum of money should go, in this order, each step taking only what it needs:
 *   1. cover a shortfall, plus the cushion, in checking
 *   2. capture the employer match still unclaimed this year (IRA)
 *   3. pay down debt above the high-interest APR, highest APR first
 *   4. build the emergency fund to the first target (1 month of essentials)
 *   5. fund savings goals, in the order given
 *   6. build the emergency fund to the second target (3 months)
 *   7. split what is left between extra retirement and extra payments on the remaining debt
 * Whatever no step can use is left unallocated. Returns exactly the Plan shape plan v0 does:
 * sum(lines) + unallocated = amount.
 */
export function planV1(facts: FactsSnapshot, goals: Goal[], amount: number): Plan {
  const lines: PlanLine[] = [];
  let remaining = r2(amount);
  let shortfallCovered = 0;

  const take = (want: number): number => {
    const put = r2(Math.min(remaining, Math.max(0, want)));
    remaining = r2(remaining - put);
    return put;
  };
  const account = (id: string) => facts.accounts.find((a) => a.id === id);

  // 1. Shortfall
  if (facts.shortfall) {
    const need = facts.shortfall.suggestedTransfer;
    const put = take(need);
    if (put > 0) {
      lines.push({
        destination: "checking",
        amount: put,
        reasonCode: "cover_shortfall",
        reasonNumbers: { shortfallAmount: facts.shortfall.amount, cushion: facts.forecast.cushion, neededWithCushion: need },
      });
      shortfallCovered = put;
    }
  }

  // 2. Employer match
  const ira = account("ira");
  const unclaimed = ira?.unclaimedMatchThisYear ?? 0;
  if (ira && unclaimed > 0) {
    const put = take(unclaimed);
    if (put > 0) {
      lines.push({
        destination: "ira",
        amount: put,
        reasonCode: "capture_employer_match",
        reasonNumbers: { unclaimedMatchThisYear: unclaimed, employerMatchPercent: ira.employerMatchPercent ?? 0, matchStillUnclaimed: r2(unclaimed - put) },
      });
    }
  }

  // 3. High-interest debt, highest APR first
  const debts = facts.accounts
    .filter((a) => (a.kind === "credit_card" || a.kind === "car_loan") && (a.aprPercent ?? 0) > THRESHOLDS.highInterestAprPercent && a.balance > 0)
    .sort((a, b) => (b.aprPercent ?? 0) - (a.aprPercent ?? 0));
  const paid: Record<string, number> = {};
  for (const debt of debts) {
    const put = take(debt.balance);
    if (put <= 0) continue;
    paid[debt.id] = put;
    const apr = debt.aprPercent ?? 0;
    lines.push({
      destination: debt.id,
      amount: put,
      reasonCode: "pay_high_interest_debt",
      reasonNumbers: { aprPercent: apr, balanceBefore: debt.balance, balanceAfter: r2(debt.balance - put), monthlyInterestSaved: r2((put * apr) / 100 / 12) },
    });
  }

  // 4 and 6. Emergency fund: one month, then goals, then three months
  const savings = account("savings");
  const runway = facts.indicators.find((i) => i.id === "runway");
  const essentials = runway?.inputs.monthlyEssentials ?? 0;
  const [firstMonths, secondMonths] = THRESHOLDS.emergencyFundMonths;
  let savingsBalance = savings?.balance ?? 0;
  const fundTo = (months: number) => {
    if (!savings || essentials <= 0) return;
    const put = take(months * essentials - savingsBalance);
    if (put <= 0) return;
    lines.push({
      destination: "savings",
      amount: put,
      reasonCode: "build_emergency_fund",
      reasonNumbers: {
        runwayMonthsBefore: r2(savingsBalance / essentials),
        runwayMonthsAfter: r2((savingsBalance + put) / essentials),
        targetMonths: months,
      },
    });
    savingsBalance = r2(savingsBalance + put);
  };
  fundTo(firstMonths);

  // 5. Goals
  for (const goal of goals) {
    const put = take(goal.target - goal.saved);
    if (put <= 0) continue;
    lines.push({
      destination: `goal:${goal.id}`,
      amount: put,
      reasonCode: "fund_goal",
      reasonNumbers: { goalTarget: goal.target, savedBefore: goal.saved, savedAfter: r2(goal.saved + put), remainingAfter: r2(goal.target - goal.saved - put) },
    });
  }

  fundTo(secondMonths);

  // 7. The rest: half to retirement (up to the target), half to what is still owed (car loan before anything else)
  if (remaining > 0) {
    const retirementRoom = ira?.retirementTarget ? Math.max(0, ira.retirementTarget - (ira.balance + (lines.find((l) => l.reasonCode === "capture_employer_match")?.amount ?? 0))) : 0;
    const stillOwed = facts.accounts
      .filter((a) => (a.kind === "credit_card" || a.kind === "car_loan") && a.balance - (paid[a.id] ?? 0) > 0)
      .sort((a, b) => (b.aprPercent ?? 0) - (a.aprPercent ?? 0));
    const owedTotal = stillOwed.reduce((s, a) => s + a.balance - (paid[a.id] ?? 0), 0);

    const pot = remaining;
    let toRetirement = Math.min(r2(pot / 2), retirementRoom);
    let toDebt = Math.min(r2(pot - toRetirement), owedTotal);
    toRetirement = Math.min(r2(pot - toDebt), retirementRoom); // if debt could not use its half, retirement takes more

    if (ira && toRetirement > 0) {
      const put = take(toRetirement);
      const base = ira.balance + (lines.find((l) => l.reasonCode === "capture_employer_match")?.amount ?? 0);
      lines.push({
        destination: "ira",
        amount: put,
        reasonCode: "extra_retirement",
        reasonNumbers: { iraBalanceBefore: base, iraBalanceAfter: r2(base + put), retirementTarget: ira.retirementTarget ?? 0, percentOfTargetAfter: ira.retirementTarget ? r2(((base + put) / ira.retirementTarget) * 100) : 0 },
      });
    }
    for (const debt of stillOwed) {
      if (toDebt <= 0) break;
      const before = debt.balance - (paid[debt.id] ?? 0);
      const put = take(Math.min(toDebt, before));
      toDebt = r2(toDebt - put);
      if (put <= 0) continue;
      const apr = debt.aprPercent ?? 0;
      lines.push({
        destination: debt.id,
        amount: put,
        reasonCode: "extra_debt_payment",
        reasonNumbers: { aprPercent: apr, balanceBefore: before, balanceAfter: r2(before - put), monthlyInterestSaved: r2((put * apr) / 100 / 12) },
      });
    }
  }

  return { schemaVersion: 1, asOf: facts.asOf, amount: r2(amount), shortfallCovered, unallocated: remaining, lines };
}
