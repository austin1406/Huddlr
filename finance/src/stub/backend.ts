import type { FactsSnapshot, Scenario, WhatIfResult } from "../../../contracts/src";
import type { Backend } from "../backend";
import { FIXTURES } from "../data/fixtures";
import { canIAfford, r2 } from "../engine/afford";
import { daysBetween } from "../engine/calendar";
import { planV0 } from "../engine/plan";
import type { ScenarioName } from "../env";
import { StubState } from "./state";

/**
 * purchase_now is computed from the fixture forecast. The other scenarios return the fixture result with the
 * requested scenario echoed back (shape only); the engine computes them for real.
 */
function stubWhatIf(facts: FactsSnapshot, scenario: Scenario, fixture: WhatIfResult): WhatIfResult {
  if (scenario.type !== "purchase_now") return { ...fixture, scenario };
  const fc = facts.forecast;
  const runway = facts.indicators.find((i) => i.id === "runway");
  const statuses = Object.fromEntries(facts.indicators.map((i) => [i.id, i.status]));
  const after = canIAfford(facts, scenario.amount);
  return {
    schemaVersion: 1,
    scenario,
    before: { lowestBalance: fc.lowest, firstNegativeDate: fc.firstNegativeDate, runwayMonths: runway?.value ?? 0, indicatorStatuses: statuses },
    after: { lowestBalance: after.lowestBalanceAfter, firstNegativeDate: after.firstNegativeDateAfter, runwayMonths: runway?.value ?? 0, indicatorStatuses: statuses },
    changedIndicators: [],
    daysUntilNegative: after.firstNegativeDateAfter ? daysBetween(facts.localDate, after.firstNegativeDateAfter) : null,
  };
}

/** The Gate 0 stub: fixtures at the real URLs. Kept so FINANCE_MODE=stub still works for teammates' tests. */
export class StubBackend implements Backend {
  readonly mode = "stub" as const;
  constructor(readonly state: StubState = new StubState()) {}

  async health() {
    return { ok: true, service: "finance", mode: "stub", scenario: this.state.scenario };
  }
  async facts(override?: ScenarioName) {
    return this.state.facts(override);
  }
  async listEvents(after?: string, limit = 50) {
    return this.state.listEvents(after, limit);
  }
  async canIAfford(amount: number) {
    return canIAfford(this.state.facts(), amount);
  }
  async whatIf(scenario: Scenario) {
    return stubWhatIf(this.state.facts(), scenario, FIXTURES.whatIf);
  }
  async plan(amount: number) {
    return planV0(this.state.facts(), r2(amount));
  }
  async pending() {
    return this.state.pending();
  }
  async accept(proposalId: string) {
    return this.state.accept(proposalId);
  }
  scenario() {
    return this.state.scenario;
  }
  async setScenario(name: ScenarioName) {
    this.state.reset(name);
  }
  async addEvent(event: Parameters<StubState["addEvent"]>[0]) {
    return this.state.addEvent(event);
  }
  async reset() {
    this.state.reset(this.state.scenario);
  }
}
