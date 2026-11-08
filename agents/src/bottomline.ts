// "So what should I do?" -> one clear answer: the single action, why in plain words, and what else the plan
// suggests. Built in code from the waiting proposal and P1's facts, so it's instant, exact, and never vague.
import type { FactsSnapshot, Plan, PlanLine } from "../../contracts/src";

const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const NAME: Record<string, string> = { checking: "Checking", savings: "Savings", card: "your card", car_loan: "your car loan", ira: "your IRA" };

/** Why a plan line matters, in one plain sentence, using only that line's own numbers. */
export function whyLine(l: PlanLine): string {
  const n = l.reasonNumbers as Record<string, number>;
  switch (l.reasonCode) {
    case "capture_employer_match":
      return `That grabs your employer match: free money your job adds when you put money in.`;
    case "pay_high_interest_debt":
      return n.monthlyInterestSaved
        ? `That cuts your ${n.aprPercent ?? ""}% card interest, saving about ${usd(n.monthlyInterestSaved)} a month.`.replace("  ", " ")
        : `That pays down your highest-interest debt first.`;
    case "cover_shortfall":
      return `That keeps Checking from going below zero before payday.`;
    case "build_emergency_fund":
      return `That makes your savings cover more weeks of bills if your income ever stopped.`;
    case "fund_goal":
      return `That moves you closer to your goal.`;
    case "extra_retirement":
      return `That adds to your retirement savings.`;
    case "extra_debt_payment":
      return n.monthlyInterestSaved ? `That pays your debt down faster, saving about ${usd(n.monthlyInterestSaved)} a month in interest.` : `That pays your debt down faster.`;
  }
}

/**
 * The bottom line. With a plan waiting: "Bottom line: reply YES to …" plus why, plus the rest of the plan as
 * something they can do themselves later. With nothing waiting: whether anything needs doing right now.
 */
export function bottomLine(facts: FactsSnapshot, waiting: { actionText: string; to: string; plan: Plan; windfall: boolean } | null): string {
  if (waiting) {
    const yes = waiting.plan.lines.find((l) => l.destination === waiting.to && l.amount > 0);
    const rest = waiting.plan.lines.filter((l) => l !== yes && l.amount > 0 && !String(l.destination).startsWith("goal:"));
    const keep = waiting.windfall ? rest.filter((l) => l.destination === "checking") : [];
    const later = rest.filter((l) => !keep.includes(l));
    return [
      `Bottom line: reply YES to ${waiting.actionText.charAt(0).toLowerCase()}${waiting.actionText.slice(1)}.`,
      ...(yes ? [whyLine(yes)] : []),
      ...keep.map((l) => `Keep ${usd(l.amount)} in Checking so you're not short before payday.`),
      ...(later.length ? [`The plan also suggests ${later.map((l) => `${usd(l.amount)} to ${NAME[String(l.destination)] ?? String(l.destination)}`).join(" and ")}; you can do that in your bank app whenever you're ready.`] : []),
    ].join(" ");
  }
  const s = facts.shortfall;
  if (s)
    return `Bottom line: you'd be short ${usd(s.amount)} on ${day(s.firstNegativeDate)}. Moving ${usd(s.suggestedTransfer)} from Savings to Checking fixes it, and I'll send you that plan to approve.`;
  const f = facts.forecast;
  return `Bottom line: nothing needs your OK right now. You have ${usd(f.safeToSpendUntilPayday)} safe to spend until payday on ${day(f.nextPayday)}.`;
}
