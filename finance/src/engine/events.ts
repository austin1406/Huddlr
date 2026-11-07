import { makeEventId, type FactsSnapshot, type FinanceEvent, type Persona } from "../../../contracts/src";
import { P2P_IMBALANCE_MIN, THRESHOLDS } from "../data/config";
import { daysBetween } from "./calendar";
import type { LedgerState } from "./ledger";

/** Append-only, deduped by id. Order is the order events were first detected. */
export class EventLog {
  private events: FinanceEvent[] = [];
  private ids = new Set<string>();

  constructor(initial: FinanceEvent[] = []) {
    for (const e of initial) this.add(e);
  }

  /** False when an event with this id already exists (duplicate protection). */
  add(event: FinanceEvent): boolean {
    if (this.ids.has(event.id)) return false;
    this.ids.add(event.id);
    this.events.push(event);
    return true;
  }

  /** Events after the one with id `after`, oldest first. Unknown `after` returns everything. */
  after(afterId: string | undefined, limit = 50): FinanceEvent[] {
    const at = afterId ? this.events.findIndex((e) => e.id === afterId) : -1;
    return this.events.slice(at + 1, at + 1 + limit);
  }

  recent(n = 5): FinanceEvent[] {
    return this.events.slice(-n);
  }

  all(): FinanceEvent[] {
    return [...this.events];
  }
}

/**
 * Finds everything notable in the current state. Ids come from the source record (a transaction id, a bill and
 * its due date, a first-negative date), never from the time, so calling this again can never repeat an event.
 */
export function detectEvents(state: LedgerState, persona: Persona, facts: FactsSnapshot): FinanceEvent[] {
  const out: FinanceEvent[] = [];
  const now = facts.asOf;

  for (const t of state.txns) {
    if (t.kind === "paycheck") {
      out.push({ id: makeEventId("paycheck_landed", t.id), type: "paycheck_landed", occurredAt: t.occurredAt, severity: "low", accountId: "checking", data: { amount: t.amount } });
    } else if (t.kind === "purchase" && t.amount >= THRESHOLDS.bigPurchaseMin) {
      out.push({
        id: makeEventId("big_purchase", t.id), type: "big_purchase", occurredAt: t.occurredAt, severity: "medium", accountId: t.accountId,
        data: { merchant: t.merchant ?? "Purchase", amount: t.amount, category: t.category ?? "shopping" },
      });
    } else if (t.kind === "transfer" && t.from && t.to) {
      out.push({
        id: makeEventId("user_transfer_seen", t.id), type: "user_transfer_seen", occurredAt: t.occurredAt, severity: "low", accountId: t.to,
        data: { amount: t.amount, from: t.from, to: t.to, matchedProposalId: null },
      });
    }
  }

  for (const bill of facts.upcomingBills) {
    const daysUntil = daysBetween(facts.localDate, bill.dueDate);
    if (daysUntil > THRESHOLDS.billDueSoonDays) continue;
    out.push({
      id: makeEventId("bill_due_soon", `${bill.id}_${bill.dueDate}`), type: "bill_due_soon", occurredAt: now, severity: "medium", accountId: "checking",
      data: { billId: bill.id, amount: bill.amount, dueDate: bill.dueDate, daysUntil },
    });
  }

  const firstNegative = facts.forecast.firstNegativeDate;
  if (firstNegative && facts.shortfall && daysBetween(facts.localDate, firstNegative) <= THRESHOLDS.forecastProblemWithinDays) {
    out.push({
      id: makeEventId("forecast_problem", firstNegative), type: "forecast_problem", occurredAt: now, severity: "high", accountId: "checking",
      data: { firstNegativeDate: firstNegative, amount: facts.shortfall.amount },
    });
  }

  for (const peer of state.peers) {
    if (peer.owesUser < P2P_IMBALANCE_MIN) continue;
    out.push({
      id: makeEventId("p2p_imbalance", `${peer.name.toLowerCase()}_${peer.owesUser}`), type: "p2p_imbalance", occurredAt: now, severity: "low", accountId: "checking",
      data: { peer: peer.name, owesUser: peer.owesUser },
    });
  }

  return out;
}
