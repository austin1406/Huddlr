import type { AcceptProposalResponse, FactsSnapshot, FinanceEvent, ProposalStatus, ProposalSummary } from "../../../contracts/src";
import { FIXTURES } from "../data/fixtures";
import type { ScenarioName } from "../env";

const byTime = (a: FinanceEvent, b: FinanceEvent) => a.occurredAt.localeCompare(b.occurredAt);

/** In-memory state for the stub: which fixture to serve, injected events, and proposal decisions. */
export class StubState {
  scenario: ScenarioName;
  private events: FinanceEvent[] = [];
  private injected: FinanceEvent[] = [];
  private decided = new Map<string, ProposalStatus>();

  constructor(scenario: ScenarioName = "normal") {
    this.scenario = scenario;
    this.reset(scenario);
  }

  reset(scenario: ScenarioName = this.scenario): void {
    this.scenario = scenario;
    this.events = [...FIXTURES.events].sort(byTime);
    this.injected = [];
    this.decided.clear();
  }

  /** Facts for the active scenario (or an override for one request), with this session's decisions applied. */
  facts(override?: ScenarioName): FactsSnapshot {
    const base = structuredClone(FIXTURES[override ?? this.scenario]);
    base.pendingProposals = base.pendingProposals
      .map((p) => ({ ...p, status: this.decided.get(p.id) ?? p.status }))
      .filter((p) => p.status === "pending");
    const known = new Set(base.recentEvents.map((e) => e.id));
    base.recentEvents = [...base.recentEvents, ...this.injected.filter((e) => !known.has(e.id))].slice(-5);
    return base;
  }

  /** Events after the one with id `after` (insertion order), oldest first. Unknown `after` returns everything. */
  listEvents(after?: string, limit = 50): FinanceEvent[] {
    const at = after ? this.events.findIndex((e) => e.id === after) : -1;
    return this.events.slice(at + 1, at + 1 + limit);
  }

  /** Returns false if an event with the same id already exists (duplicate protection). */
  addEvent(event: FinanceEvent): boolean {
    if (this.events.some((e) => e.id === event.id)) return false;
    this.events.push(event);
    this.injected.push(event);
    return true;
  }

  pending(): ProposalSummary | null {
    return this.facts().pendingProposals[0] ?? null;
  }

  /** Mirrors the agents service's rules: accepting twice is a normal outcome, not an error. */
  accept(proposalId: string): AcceptProposalResponse {
    const proposal = FIXTURES[this.scenario].pendingProposals.find((p) => p.id === proposalId);
    if (!proposal) return { ok: false, status: "declined", reason: "not_found", message: "No such proposal." };
    const status = this.decided.get(proposalId) ?? proposal.status;
    if (status === "pending") {
      this.decided.set(proposalId, "accepted");
      return { ok: true, status: "accepted", reason: null, message: `Recorded your yes to: ${proposal.actionText}` };
    }
    const reason =
      status === "accepted" ? "already_accepted" : status === "expired" ? "expired" : status === "completed" ? "already_completed" : "not_pending";
    return { ok: false, status, reason };
  }
}
