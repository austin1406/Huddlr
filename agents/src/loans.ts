// Loans the user tells us about by text ("I took a loan out for tuition", "it's 10000, add that in", "5%, $150 a
// month"). The bank data (P1) has one loan; these are extra loans the Loan character keeps track of. Saved in
// memory_facts (key loan:<name>), so text and voice share them. Pattern-based: no model call, nothing invented.
//
// They are NOT in P1's ledger, so forecasts and plans don't include their payments; the Loan character says so.
import type { FactsSnapshot } from "../../contracts/src";
import { amortize } from "./character";
import type { Queryable } from "./db";

export interface ReportedLoan {
  key: string;
  label: string;
  owed?: number;
  aprPercent?: number;
  monthlyPayment?: number;
  /** How long the loan runs, if the user said ("for 24 months"). With the rate, it gives the monthly payment. */
  termMonths?: number;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (s: string) => {
  const t = s.replace(/[$,\s]/g, "").toLowerCase();
  return t.endsWith("k") ? Number(t.slice(0, -1)) * 1000 : Number(t);
};
const isQuestion = (t: string) => /\?\s*$/.test(t) || /^(how|what|what's|whats|why|where|when|which|who|can|could|should|would|is|am|are|do|does|did|will|explain)\b/i.test(t.trim());

/** Rate and monthly payment, wherever they appear ("at 5%", "5% interest", "$150 a month", "monthly payment of 150"). */
export function parseTerms(text: string): { aprPercent?: number; monthlyPayment?: number } {
  const apr = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const pay =
    text.match(/\$?\s*([\d,]+(?:\.\d+)?k?)\s*(?:\/\s*mo(?:nth)?\b|a month|per month|monthly|each month|every month)/i) ??
    text.match(/(?:monthly payment|payment|pay)\s*(?:is|of|=)?\s*\$?\s*([\d,]+(?:\.\d+)?k?)/i);
  return {
    ...(apr ? { aprPercent: Number(apr[1]) } : {}),
    ...(pay && num(pay[1]) > 0 ? { monthlyPayment: num(pay[1]) } : {}),
  };
}

/** What a text says about a loan the user has, or null. "I took a loan out for tuition", "add my $10k student loan". */
export function parseLoanReport(text: string): (Partial<ReportedLoan> & { label: string }) | null {
  const t = text.trim();
  if (isQuestion(t) || !/\bloans?\b/i.test(t)) return null;
  // Thinking about a loan isn't having one: "i wanna ... take a loan out", "can i ... take a loan out for a house".
  if (/\b(wanna|want to|wants to|would like to|thinking (?:of|about)|planning (?:to|on)|plan to|gonna|going to|hoping to|might|maybe|should i|can i|could i|if i|considering)\b/i.test(t)) return null;
  if (!/\b(took|take|taking|have|has|had|got|get|new|add|added|adding|owe|borrowed|signed|started|opened)\b/i.test(t)) return null;
  const kind =
    t.match(/\b(student|tuition|school|college|personal|medical|home|house|business|wedding|payday|bank|car|auto)\s+loan/i)?.[1] ??
    t.match(/\bloans?\s+(?:out\s+)?for\s+(?:my\s+|a\s+|an\s+|the\s+)?([a-z]+)/i)?.[1] ??
    null;
  // The car loan is already in the bank data.
  if (kind && /^(car|auto)$/i.test(kind)) return null;
  const label = `${(kind ?? "other").toLowerCase()} loan`;
  return { label, ...parseLoanNumbers(t) };
}

/**
 * Every loan number in a text: the amount owed, the rate, the monthly payment, and the length ("18000 for 24 months",
 * "$10k at 5% over 4 years", "$150 a month"). The amount is a money amount or a bare number of 100+ that isn't one
 * of the others.
 */
export function parseLoanNumbers(text: string): { owed?: number; aprPercent?: number; monthlyPayment?: number; termMonths?: number } {
  const t = text.trim();
  const terms = parseTerms(t);
  const len = t.match(/(?:for|over|in|of|lasting)?\s*(\d+(?:\.\d+)?)\.?\s*(months?|mos?|years?|yrs?)\b/i);
  const termMonths = len ? Math.round(Number(len[1]) * (/^y/i.test(len[2]) ? 12 : 1)) : undefined;
  const stripped = t
    .replace(/(\d+(?:\.\d+)?)\s*%/g, " ")
    .replace(/\$?\s*[\d,]+(?:\.\d+)?k?\s*(?:\/\s*mo(?:nth)?\b|a month|per month|monthly|each month|every month)/gi, " ")
    .replace(/(?:monthly payment|payment|pay)\s*(?:is|of|=)?\s*\$?\s*[\d,]+(?:\.\d+)?k?/gi, " ")
    .replace(/\d+(?:\.\d+)?\.?\s*(?:months?|mos?|years?|yrs?)\b/gi, " ");
  const amounts = [...stripped.matchAll(/\$?\s*\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(k)?\b/gi)].map((m) => num(m[0])).filter((n) => n >= 100);
  return {
    ...(amounts.length === 1 ? { owed: amounts[0] } : {}),
    ...terms,
    ...(termMonths && termMonths > 0 ? { termMonths } : {}),
  };
}

/** The monthly payment for `owed` at `aprPercent` paid off over `termMonths` (standard amortization). */
export function paymentFor(owed: number, aprPercent: number, termMonths: number): number {
  const r = aprPercent / 100 / 12;
  const p = r === 0 ? owed / termMonths : (r * owed) / (1 - Math.pow(1 + r, -termMonths));
  return Math.round(p * 100) / 100;
}

const keyFor = (label: string) => `loan:${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

export async function loadReportedLoans(db: Queryable, phone: string): Promise<ReportedLoan[]> {
  const r = await db.query<{ key: string; value: Omit<ReportedLoan, "key"> | string }>(
    "SELECT key, value FROM memory_facts WHERE user_phone = $1 AND key LIKE 'loan:%' ORDER BY updated_sim_at",
    [phone],
  );
  return r.rows.map((row) => ({ key: row.key, ...(typeof row.value === "string" ? JSON.parse(row.value) : row.value) }));
}

async function save(db: Queryable, phone: string, loan: ReportedLoan, now: Date) {
  const { key, ...value } = loan;
  await db.query(
    `INSERT INTO memory_facts (user_phone, kind, key, value, source, created_sim_at, updated_sim_at)
     VALUES ($1, 'note', $2, $3, 'text', $4, $4)
     ON CONFLICT (user_phone, key) DO UPDATE SET value = EXCLUDED.value, updated_sim_at = EXCLUDED.updated_sim_at`,
    [phone, key, JSON.stringify(value), now],
  );
}

/** The loan still missing its amount, rate or payment that we last asked about (for "5%, $150 a month" follow-ups). */
async function waitingOn(db: Queryable, phone: string): Promise<string | null> {
  const r = await db.query<{ value: string }>("SELECT value FROM agent_state WHERE key = $1", [`loan_pending:${phone}`]);
  return r.rows[0]?.value ?? null;
}
async function setWaiting(db: Queryable, phone: string, key: string | null) {
  if (key == null) await db.query("DELETE FROM agent_state WHERE key = $1", [`loan_pending:${phone}`]);
  else
    await db.query(
      `INSERT INTO agent_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [`loan_pending:${phone}`, key],
    );
}

const complete = (l: ReportedLoan) => l.owed != null && l.aprPercent != null && l.monthlyPayment != null;

/** One line about a reported loan, with the breakdown when we have its rate and payment. Code-built, exact. */
export function describeLoan(l: ReportedLoan, localDate: string): string {
  if (l.owed == null) return `your ${l.label} (amount not given yet)`;
  if (!complete(l)) return `your ${l.label}: ${usd(l.owed)} owed${l.termMonths ? ` over ${l.termMonths} months` : ""}`;
  const b = amortize({ label: l.label, owed: l.owed, aprPercent: l.aprPercent!, monthlyPayment: l.monthlyPayment! }, localDate);
  if (!b) return `your ${l.label}: ${usd(l.owed)} owed at ${l.aprPercent}%, ${usd(l.monthlyPayment!)} a month (that payment doesn't cover the interest)`;
  return `your ${l.label}: ${usd(l.owed)} owed at ${l.aprPercent}%, ${usd(l.monthlyPayment!)} a month (about ${usd(b.interestThisMonth)} interest, ${usd(b.principalThisMonth)} toward what you owe); paid off around ${b.payoffMonth}`;
}

/** Every number in the reported loans and their breakdowns, so the checker accepts them in the Loan character's words. */
export function loanSources(loans: ReportedLoan[], localDate: string): unknown[] {
  return loans.map((l) => ({ ...l, breakdown: complete(l) ? amortize({ label: l.label, owed: l.owed!, aprPercent: l.aprPercent!, monthlyPayment: l.monthlyPayment! }, localDate) : null }));
}

/** Everything owed on loans: the bank's loan plus every reported loan with an amount. */
export function totalLoansOwed(facts: FactsSnapshot, loans: ReportedLoan[]): number {
  const bank = facts.accounts.find((a) => a.id === "car_loan")?.balance ?? 0;
  return Math.round((bank + loans.reduce((s, l) => s + (l.owed ?? 0), 0)) * 100) / 100;
}

/**
 * Handles a text that reports a loan, or fills in a loan we asked about. Returns the Loan character's reply, or null
 * if this text isn't about a reported loan.
 */
export async function handleLoanReport(db: Queryable, phone: string, text: string, facts: FactsSnapshot, now: Date): Promise<string | null> {
  const loans = await loadReportedLoans(db, phone);
  let report = parseLoanReport(text);
  let existing: ReportedLoan | undefined;

  if (report) {
    // "add that in" after "I took a loan out for tuition": an unnamed report updates the loan we're waiting on.
    const pendingKey = await waitingOn(db, phone);
    existing = loans.find((l) => l.key === keyFor(report!.label)) ?? (report.label === "other loan" && pendingKey ? loans.find((l) => l.key === pendingKey) : undefined);
  } else {
    // "5%, $150 a month", "18000 for 24 months" right after we asked: fill in the loan we're waiting on.
    const pendingKey = await waitingOn(db, phone);
    if (!pendingKey || isQuestion(text)) return null;
    const nums = parseLoanNumbers(text);
    if (nums.owed == null && nums.aprPercent == null && nums.monthlyPayment == null && nums.termMonths == null) return null;
    existing = loans.find((l) => l.key === pendingKey);
    if (!existing) return null;
    report = { label: existing.label, ...nums };
  }

  const isNew = !existing;
  const loan: ReportedLoan = {
    key: existing?.key ?? keyFor(report.label),
    label: existing?.label ?? report.label,
    ...(existing?.owed != null ? { owed: existing.owed } : {}),
    ...(existing?.aprPercent != null ? { aprPercent: existing.aprPercent } : {}),
    ...(existing?.monthlyPayment != null ? { monthlyPayment: existing.monthlyPayment } : {}),
    ...(existing?.termMonths != null ? { termMonths: existing.termMonths } : {}),
    ...(report.owed != null ? { owed: report.owed } : {}),
    ...(report.aprPercent != null ? { aprPercent: report.aprPercent } : {}),
    ...(report.monthlyPayment != null ? { monthlyPayment: report.monthlyPayment } : {}),
    ...(report.termMonths != null ? { termMonths: report.termMonths } : {}),
  };
  // Amount, rate and length are enough: the monthly payment follows from them.
  if (loan.monthlyPayment == null && loan.owed != null && loan.aprPercent != null && loan.termMonths)
    loan.monthlyPayment = paymentFor(loan.owed, loan.aprPercent, loan.termMonths);
  await save(db, phone, loan, now);

  // With the length known, only the rate is needed (the payment is worked out); otherwise the rate and the payment.
  const terms = [loan.aprPercent == null ? "interest rate" : null, loan.monthlyPayment == null && !loan.termMonths ? "monthly payment" : null].filter(Boolean) as string[];
  const missingAny = loan.owed == null || terms.length > 0;
  await setWaiting(db, phone, missingAny ? loan.key : null);

  const all = [...loans.filter((l) => l.key !== loan.key), loan];
  const parts: string[] = [];
  const article = !isNew ? "your" : loan.label === "other loan" ? "" : /^[aeiou]/i.test(loan.label) ? "an" : "a";
  const named = loan.label === "other loan" && isNew ? "another loan" : `${article} ${loan.label}`;
  parts.push(loan.owed == null ? `Got it, ${named}.` : `${isNew ? "Added" : "Updated"} ${describeLoan(loan, facts.localDate)}.`);
  if (missingAny) {
    const termsText = terms.length ? `the ${terms.join(" and ")}` : "";
    const ask = loan.owed == null
      ? `How much do you owe on it${termsText ? `, and what's ${termsText}` : ""}?`
      : `What's ${termsText}?`;
    parts.push(`${ask} With that I can show how each payment splits and when it's paid off.`);
  }
  if (loan.owed != null) parts.push(`With your other loan${all.length > 1 ? "s" : ""}, you owe ${usd(totalLoansOwed(facts, all))} on loans in total.`);
  if (isNew) parts.push(`It isn't in your bank data, so forecasts and plans don't count its payment yet.`);
  return parts.join(" ");
}

/** "Can I get a house?", "can I take out a loan for a home?", "am I ready for a mortgage?" */
export const isHomeQuestion = (text: string) =>
  /\b(house|home|mortgage|condo|apartment)\b/i.test(text) &&
  /\b(can i|could i|should i|am i|if i|want|wanna|thinking|planning|going to|gonna|qualify|afford|ready)\b/i.test(text) &&
  /\b(get|buy|take out|take|afford|qualify|loan|mortgage|purchase|ready)\b/i.test(text);

/**
 * What a lender looks at for a home loan, from the user's real numbers (computed in code so every number passes the
 * checker): monthly income from their paychecks, the debt payments they already make each month, what share of
 * income those take, savings for a down payment, and how much of the card limit is used. Plus the common guidelines
 * (debt payments under about 36% of income; a down payment of 3% to 20%).
 */
export function homeLoanCheck(facts: FactsSnapshot, reported: ReportedLoan[]) {
  const pay = facts.upcomingPaychecks;
  const paycheck = pay[0]?.amount ?? 0;
  const days = pay.length > 1 ? Math.round((Date.parse(pay[1].date) - Date.parse(pay[0].date)) / 86_400_000) : 14;
  const monthlyIncome = Math.round(((paycheck * 365) / Math.max(1, days) / 12) * 100) / 100;
  const a = (id: string) => facts.accounts.find((x) => x.id === id);
  const debts = [
    ...(a("car_loan")?.monthlyPayment ? [{ name: "loan payment", amount: a("car_loan")!.monthlyPayment! }] : []),
    ...(a("card")?.minimumPayment ? [{ name: "card minimum", amount: a("card")!.minimumPayment! }] : []),
    ...reported.filter((r) => r.monthlyPayment).map((r) => ({ name: `${r.label} payment`, amount: r.monthlyPayment! })),
  ];
  const monthlyDebt = Math.round(debts.reduce((s, d) => s + d.amount, 0) * 100) / 100;
  const debtSharePercent = monthlyIncome > 0 ? Math.round((monthlyDebt / monthlyIncome) * 100) : null;
  const card = a("card");
  return {
    paycheck, paycheckEveryDays: days, monthlyIncome, debts, monthlyDebt, debtSharePercent,
    savings: a("savings")?.balance ?? 0,
    cardOwed: card?.balance ?? 0, cardUtilizationPercent: card?.limit ? Math.round((card.balance / card.limit) * 100) : null,
    guidelines: { maxDebtSharePercent: 36, minDownPaymentPercent: 3, typicalDownPaymentPercent: 20, cardUsePercent: 30 },
  };
}

/** The home-loan check as one line for the characters' prompts. */
export function homeLoanCheckText(facts: FactsSnapshot, reported: ReportedLoan[]): string {
  const h = homeLoanCheck(facts, reported);
  // The comparisons are made here, in code, so the model can't get them backwards.
  const debtVerdict = h.debtSharePercent == null ? "" : h.debtSharePercent <= h.guidelines.maxDebtSharePercent
    ? ` That's UNDER the ${h.guidelines.maxDebtSharePercent}% guideline, which is a plus (though a home payment would add to it).`
    : ` That's OVER the ${h.guidelines.maxDebtSharePercent}% guideline already, which would make a home loan hard.`;
  const cardVerdict = h.cardUtilizationPercent == null ? "" : h.cardUtilizationPercent > h.guidelines.cardUsePercent
    ? ` Card use over ${h.guidelines.cardUsePercent}% of the limit can lower a credit score; paying it down helps.`
    : ` Card use is under ${h.guidelines.cardUsePercent}% of the limit, which helps a credit score.`;
  return `HOME LOAN CHECK (what a lender looks at; use these exact numbers, no made-up home prices): income about ${usd(h.monthlyIncome)} a month (${usd(h.paycheck)} paychecks every ${h.paycheckEveryDays} days); debt payments already ${usd(h.monthlyDebt)} a month (${h.debts.map((d) => `${d.name} ${usd(d.amount)}`).join(", ") || "none"})${h.debtSharePercent != null ? `, about ${h.debtSharePercent}% of income` : ""}.${debtVerdict} Savings for a down payment: ${usd(h.savings)}, which is small for a down payment plus closing costs, so savings is the main thing to build. Card ${usd(h.cardOwed)} owed${h.cardUtilizationPercent != null ? ` (${h.cardUtilizationPercent}% of the limit used)` : ""}.${cardVerdict} Common guidelines: total debt payments, including a new home payment, under about ${h.guidelines.maxDebtSharePercent}% of income; a down payment of ${h.guidelines.minDownPaymentPercent}% to ${h.guidelines.typicalDownPaymentPercent}% of the price, plus closing costs.`;
}
