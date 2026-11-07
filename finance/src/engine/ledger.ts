import type { AccountId, Persona } from "../../../contracts/src";
import { addDays, billDueOn, daysBetween, isPayday, morningOf, r2 } from "./calendar";

export type TxnKind = "purchase" | "paycheck" | "bill" | "transfer" | "daily";

/** One money movement. `date` is the customer's local day, `occurredAt` the instant. Ids are stable, never time-based. */
export interface Txn {
  id: string;
  date: string;
  occurredAt: string;
  kind: TxnKind;
  amount: number;
  accountId: AccountId;
  merchant?: string;
  category?: string;
  from?: AccountId;
  to?: AccountId;
  billId?: string;
  label?: string;
  /** A bill paid from an account that went negative counts as late. */
  late?: boolean;
}

export interface OneOffBill {
  id: string;
  label: string;
  amount: number;
  dueDate: string;
  essential: boolean;
  paid: boolean;
}

/**
 * The persona customer's money, as the engine sees it. Balances are as of the START of `settledThrough + 1`
 * (that is, today, before today's spending). Days before today are settled by `settleThrough`.
 */
export interface LedgerState {
  version: 1;
  createdDate: string;
  settledThrough: string;
  balances: Record<AccountId, number>;
  daysSinceLastContribution: number;
  lastPaid: string;
  paycheckAmount: number;
  oneOffBills: OneOffBill[];
  txns: Txn[];
  onTimeBillStreak: number;
  peers: { name: string; owesUser: number }[];
  nextSeq: number;
}

/** What the engine can be told to start from, for demos and tests. */
export interface LedgerOverrides {
  checking?: number;
  lastPaidDaysAgo?: number;
}

/** Recurring bills that pay down a debt as well as leaving checking. */
const DEBT_FOR_BILL: Record<string, AccountId> = { card_minimum: "card", car_loan: "car_loan" };

export function createLedger(persona: Persona, today: string, overrides: LedgerOverrides = {}): LedgerState {
  const a = persona.accounts;
  return {
    version: 1,
    createdDate: today,
    settledThrough: addDays(today, -1),
    balances: {
      checking: overrides.checking ?? a.checking.balance,
      savings: a.savings.balance,
      card: a.card.balance,
      car_loan: a.carLoan.balance,
      ira: a.ira.balance,
    },
    daysSinceLastContribution: a.ira.daysSinceLastContribution,
    lastPaid: addDays(today, -(overrides.lastPaidDaysAgo ?? persona.income.lastPaidDaysAgo)),
    paycheckAmount: persona.income.paycheckAmount,
    oneOffBills: [],
    txns: [],
    onTimeBillStreak: persona.spending.onTimeBillStreak,
    peers: persona.peers.map((p) => ({ name: p.name, owesUser: p.owesUser })),
    nextSeq: 1,
  };
}

function push(state: LedgerState, t: Omit<Txn, "id"> & { id?: string }, prefix: string): Txn {
  const txn: Txn = { ...t, id: t.id ?? `${prefix}-${String(state.nextSeq++).padStart(4, "0")}` };
  state.txns.push(txn);
  return txn;
}

/**
 * Settle every day before `today`: paycheck if payday, bills due, then the average daily spend,
 * in that order (the same order the forecast uses). Safe to call repeatedly. Returns the new transactions.
 * Ids for settled days are derived from the date, so replaying a day can never duplicate it.
 */
export function settleThrough(state: LedgerState, persona: Persona, today: string): Txn[] {
  const created: Txn[] = [];
  const target = addDays(today, -1);
  while (state.settledThrough < target) {
    const day = addDays(state.settledThrough, 1);
    const at = morningOf(day);

    if (isPayday(state.lastPaid, persona.income.everyDays, day)) {
      state.balances.checking = r2(state.balances.checking + state.paycheckAmount);
      state.lastPaid = day;
      created.push(push(state, { id: `sim-paycheck-${day}`, date: day, occurredAt: at, kind: "paycheck", amount: state.paycheckAmount, accountId: "checking", label: "Paycheck" }, ""));
    }

    const due = [
      ...persona.recurringBills.filter((b) => billDueOn(b.dayOfMonth, day)).map((b) => ({ id: b.id, label: b.label, amount: b.amount, oneOff: null as OneOffBill | null })),
      ...state.oneOffBills.filter((b) => !b.paid && b.dueDate === day).map((b) => ({ id: b.id, label: b.label, amount: b.amount, oneOff: b })),
    ];
    for (const bill of due) {
      state.balances.checking = r2(state.balances.checking - bill.amount);
      const debt = DEBT_FOR_BILL[bill.id];
      if (debt) state.balances[debt] = Math.max(0, r2(state.balances[debt] - bill.amount));
      const late = state.balances.checking < 0;
      state.onTimeBillStreak = late ? 0 : state.onTimeBillStreak + 1;
      if (bill.oneOff) bill.oneOff.paid = true;
      created.push(push(state, { id: `sim-bill-${bill.id}-${day}`, date: day, occurredAt: at, kind: "bill", amount: bill.amount, accountId: "checking", billId: bill.id, label: bill.label, late }, ""));
    }

    state.balances.checking = r2(state.balances.checking - persona.spending.averageDailyDiscretionary);
    created.push(push(state, { id: `sim-daily-${day}`, date: day, occurredAt: at, kind: "daily", amount: persona.spending.averageDailyDiscretionary, accountId: "checking", merchant: "Everyday spending", category: "daily" }, ""));

    state.daysSinceLastContribution += 1;
    state.settledThrough = day;
  }
  return created;
}

export interface PurchaseInput {
  amount: number;
  merchant?: string;
  category?: string;
  /** checking (default) takes cash out now; card adds to what is owed. */
  account?: "checking" | "card";
}

export function postPurchase(state: LedgerState, today: string, nowIso: string, input: PurchaseInput): Txn {
  const account = input.account ?? "checking";
  const amount = r2(input.amount);
  if (account === "card") state.balances.card = r2(state.balances.card + amount);
  else state.balances.checking = r2(state.balances.checking - amount);
  return push(state, { date: today, occurredAt: nowIso, kind: "purchase", amount, accountId: account, merchant: input.merchant ?? "Purchase", category: input.category ?? "shopping" }, "sim-purchase");
}

export function postTransfer(state: LedgerState, today: string, nowIso: string, from: AccountId, to: AccountId, amount: number): Txn {
  const cents = r2(amount);
  state.balances[from] = r2(state.balances[from] - cents);
  state.balances[to] = r2(state.balances[to] + cents);
  return push(state, { date: today, occurredAt: nowIso, kind: "transfer", amount: cents, accountId: to, from, to }, "sim-transfer");
}

/**
 * Lands a paycheck now and restarts the biweekly schedule from today, so the next one is
 * `everyDays` later. Settling never double-counts today because settled days end yesterday.
 */
export function postPaycheck(state: LedgerState, today: string, nowIso: string, amount?: number): Txn {
  const cents = r2(amount ?? state.paycheckAmount);
  state.balances.checking = r2(state.balances.checking + cents);
  state.lastPaid = today;
  return push(state, { date: today, occurredAt: nowIso, kind: "paycheck", amount: cents, accountId: "checking", label: "Paycheck" }, "sim-paycheck-now");
}

export function postBill(state: LedgerState, input: { label: string; amount: number; dueDate: string; essential?: boolean }): OneOffBill {
  const bill: OneOffBill = {
    id: `oneoff-${String(state.nextSeq++).padStart(4, "0")}`,
    label: input.label,
    amount: r2(input.amount),
    dueDate: input.dueDate,
    essential: input.essential ?? true,
    paid: false,
  };
  state.oneOffBills.push(bill);
  return bill;
}

/** Income and spending over the 30 days ending today. The persona's 30-day baseline fades out as real history builds. */
export function last30Days(state: LedgerState, persona: Persona, today: string): { income: number; spending: number } {
  const since = addDays(today, -29);
  const window = state.txns.filter((t) => t.date >= since && t.date <= today);
  const income = window.filter((t) => t.kind === "paycheck").reduce((s, t) => s + t.amount, 0);
  const spending = window.filter((t) => t.kind === "purchase" || t.kind === "daily" || t.kind === "bill").reduce((s, t) => s + t.amount, 0);
  const baseline = Math.max(0, 30 - daysBetween(state.createdDate, today)) / 30;
  return {
    income: r2(persona.spending.last30Days.income * baseline + income),
    spending: r2(persona.spending.last30Days.spending * baseline + spending),
  };
}
