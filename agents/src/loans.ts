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
  if (!/\b(took|take|taking|have|has|had|got|get|new|add|added|adding|owe|borrowed|signed|started|opened)\b/i.test(t)) return null;
  const kind =
    t.match(/\b(student|tuition|school|college|personal|medical|home|house|business|wedding|payday|bank|car|auto)\s+loan/i)?.[1] ??
    t.match(/\bloans?\s+(?:out\s+)?for\s+(?:my\s+|a\s+|an\s+|the\s+)?([a-z]+)/i)?.[1] ??
    null;
  // The car loan is already in the bank data.
  if (kind && /^(car|auto)$/i.test(kind)) return null;
  const label = `${(kind ?? "other").toLowerCase()} loan`;
  const terms = parseTerms(t);
  // The amount owed: a money amount or a bare number of 100+, that isn't the rate or the monthly payment.
  const stripped = t
    .replace(/(\d+(?:\.\d+)?)\s*%/g, " ")
    .replace(/\$?\s*[\d,]+(?:\.\d+)?k?\s*(?:\/\s*mo(?:nth)?\b|a month|per month|monthly|each month|every month)/gi, " ")
    .replace(/(?:monthly payment|payment|pay)\s*(?:is|of|=)?\s*\$?\s*[\d,]+(?:\.\d+)?k?/gi, " ");
  const amounts = [...stripped.matchAll(/\$?\s*\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(k)?\b/gi)].map((m) => num(m[0])).filter((n) => n >= 100);
  return { label, ...(amounts.length === 1 ? { owed: amounts[0] } : {}), ...terms };
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
  if (!complete(l)) return `your ${l.label}: ${usd(l.owed)} owed`;
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
    // "5%, $150 a month" right after we asked: fill in the loan we're waiting on.
    const pendingKey = await waitingOn(db, phone);
    const terms = parseTerms(text);
    const bare = text.trim().match(/^\$?\s*([\d,]+(?:\.\d+)?k?)\s*$/);
    if (!pendingKey || isQuestion(text) || (!terms.aprPercent && !terms.monthlyPayment && !bare)) return null;
    existing = loans.find((l) => l.key === pendingKey);
    if (!existing) return null;
    report = { label: existing.label, ...terms, ...(bare && existing.owed == null ? { owed: num(bare[1]) } : {}) };
  }

  const isNew = !existing;
  const loan: ReportedLoan = {
    key: existing?.key ?? keyFor(report.label),
    label: existing?.label ?? report.label,
    ...(existing?.owed != null ? { owed: existing.owed } : {}),
    ...(existing?.aprPercent != null ? { aprPercent: existing.aprPercent } : {}),
    ...(existing?.monthlyPayment != null ? { monthlyPayment: existing.monthlyPayment } : {}),
    ...(report.owed != null ? { owed: report.owed } : {}),
    ...(report.aprPercent != null ? { aprPercent: report.aprPercent } : {}),
    ...(report.monthlyPayment != null ? { monthlyPayment: report.monthlyPayment } : {}),
  };
  await save(db, phone, loan, now);

  const terms = [loan.aprPercent == null ? "interest rate" : null, loan.monthlyPayment == null ? "monthly payment" : null].filter(Boolean) as string[];
  const missingAny = loan.owed == null || terms.length > 0;
  await setWaiting(db, phone, missingAny ? loan.key : null);

  const all = [...loans.filter((l) => l.key !== loan.key), loan];
  const parts: string[] = [];
  parts.push(loan.owed == null ? `Got it, ${isNew ? "a" : "your"} ${loan.label}.` : `${isNew ? "Added" : "Updated"} ${describeLoan(loan, facts.localDate)}.`);
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
