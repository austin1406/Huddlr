// "Can you give me a summary of my account?" -> every account in one message, built in code from P1's facts
// (so every number is exact and it costs no Gemini call), plus the user's priorities and any plan waiting for YES.
import type { FactsSnapshot } from "../../contracts/src";
import { cardMonthlyInterest, cast, cushionWords, loanBreakdown } from "./character";
import { describePriorities, type Priorities } from "./priorities";

export const isSummaryQuestion = (text: string) =>
  /\b(summary|summari[sz]e|overview|snapshot|rundown|where do i stand|how am i doing overall|all (?:of )?my accounts|status of my (?:accounts?|money|finances))\b/i.test(text);

const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const emoji = (id: string) => cast.find((c) => c.id === id)?.emoji ?? "";

export function accountSummary(facts: FactsSnapshot, priorities: Priorities | null, waiting: string | null): string {
  const a = (id: string) => facts.accounts.find((x) => x.id === id);
  const f = facts.forecast;
  const s = facts.shortfall;
  const lines: string[] = ["Here's where you stand:"];
  const checking = a("checking");
  if (checking)
    lines.push(`${emoji("checking")} Checking: ${usd(checking.balance)}, ${s
      ? `but short ${usd(s.amount)} on ${day(s.firstNegativeDate)}; a ${usd(s.suggestedTransfer)} transfer fixes it.`
      : `with ${usd(f.safeToSpendUntilPayday)} safe to spend until payday on ${day(f.nextPayday)}.`}`);
  const savings = a("savings");
  const cushion = cushionWords(facts);
  if (savings) lines.push(`${emoji("savings")} Savings: ${usd(savings.balance)}${cushion ? `, enough to cover ${cushion.span} of must-pay bills if your income stopped` : ""}.`);
  const card = a("card");
  const interest = cardMonthlyInterest(facts);
  if (card) lines.push(`${emoji("card")} Card: ${usd(card.balance)} owed${card.aprPercent ? ` at ${card.aprPercent}% APR` : ""}${interest ? `, about ${usd(interest)} a month in interest` : ""}.`);
  const loan = a("car_loan");
  const lb = loanBreakdown(facts);
  if (loan)
    lines.push(lb
      ? `${emoji("car_loan")} Loan: ${usd(lb.owed)} owed at ${lb.aprPercent}%, ${usd(lb.monthlyPayment)} a month (about ${usd(lb.interestThisMonth)} interest, ${usd(lb.principalThisMonth)} toward what you owe); paid off around ${lb.payoffMonth}.`
      : `${emoji("car_loan")} Loan: ${usd(loan.balance)} owed${loan.monthlyPayment ? `, ${usd(loan.monthlyPayment)} a month` : ""}.`);
  const ira = a("ira");
  if (ira) lines.push(`${emoji("ira")} IRA: ${usd(ira.balance)}${ira.unclaimedMatchThisYear ? `, with ${usd(ira.unclaimedMatchThisYear)} of employer match still unclaimed` : ""}.`);
  const prio = describePriorities(priorities);
  if (prio) lines.push(`Your priorities: ${prio}.`);
  if (waiting) lines.push(`Still to do: ${waiting} in your bank app.`);
  return lines.join("\n");
}
