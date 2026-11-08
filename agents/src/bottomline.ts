// "So what should I do?" -> one clear answer: the single action, why in plain words, and what else the plan
// suggests. Built in code from the waiting proposal and P1's facts, so it's instant, exact, and never vague.
import type { FactsSnapshot, Plan, PlanLine } from "../../contracts/src";
import { allMovesText } from "./priorities";

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const NAME: Record<string, string> = { checking: "Checking", savings: "Savings", card: "your card", car_loan: "your loan", ira: "your IRA" };

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
 * The bottom line. With a plan waiting: "Bottom line: move $150.00 from Checking to IRA and $450.00 from Checking
 * to Card in your bank app." (every move, the lead one first) plus why the lead one matters. The Coach can't move
 * money, so it never asks for a YES. With nothing waiting: whether anything needs doing right now.
 */
export function bottomLine(facts: FactsSnapshot, waiting: { actionText: string; to: string; plan: Plan; windfall: boolean } | null): string {
  if (waiting) {
    const yes = waiting.plan.lines.find((l) => l.destination === waiting.to && l.amount > 0);
    const keep = waiting.windfall ? waiting.plan.lines.filter((l) => l.destination === "checking" && l.amount > 0) : [];
    return [
      `Bottom line: ${lower(allMovesText(waiting.plan, yes ?? null, { windfall: waiting.windfall }) ?? waiting.actionText)} in your bank app.`,
      ...(yes ? [whyLine(yes)] : []),
      ...keep.map((l) => `Keep ${usd(l.amount)} in Checking so you're not short before payday.`),
      `I'll check it off when I see the transfer.`,
    ].join(" ");
  }
  const s = facts.shortfall;
  if (s)
    return `Bottom line: you'd be short ${usd(s.amount)} on ${day(s.firstNegativeDate)}. Moving ${usd(s.suggestedTransfer)} from Savings to Checking in your bank app fixes it.`;
  const f = facts.forecast;
  return `Bottom line: nothing needs your OK right now. You have ${usd(f.safeToSpendUntilPayday)} safe to spend until payday on ${day(f.nextPayday)}.`;
}
