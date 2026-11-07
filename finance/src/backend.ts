import type {
  AccountId,
  AcceptProposalResponse,
  CanIAffordResponse,
  FactsSnapshot,
  FinanceEvent,
  Plan,
  ProposalSummary,
  Scenario,
  SimState,
  WhatIfResult,
} from "../../contracts/src";
import type { ScenarioName } from "./env";
import type { Txn } from "./engine/ledger";

export interface AdminState {
  sim: SimState;
  now: string;
  today: string;
  balances: Record<AccountId, number>;
  lastPaid: string;
  settledThrough: string;
  unpaidOneOffBills: { id: string; label: string; amount: number; dueDate: string }[];
  txnCount: number;
  eventCount: number;
  recentTxns: Txn[];
}

export interface PurchaseOp {
  amount: number;
  merchant?: string;
  category?: string;
  account?: "checking" | "card";
}

export interface BillOp {
  label: string;
  amount: number;
  /** Either an explicit local date or a number of days from today. Defaults to 2 days from today. */
  dueDate?: string;
  dueInDays?: number;
  essential?: boolean;
}

/** Controls for the engine's simulated world. The demo controller and the CLI scripts go through these. */
export interface EngineOps {
  state(): Promise<AdminState>;
  jumpDays(days: number): Promise<SimState>;
  setDemoMode(on: boolean): Promise<SimState>;
  purchase(op: PurchaseOp): Promise<Txn>;
  transfer(from: AccountId, to: AccountId, amount: number): Promise<Txn>;
  paycheck(amount?: number): Promise<Txn>;
  bill(op: BillOp): Promise<{ id: string; label: string; amount: number; dueDate: string }>;
}

/** What the HTTP layer needs. The stub answers from fixtures; the engine computes from the persona's ledger. */
export interface Backend {
  readonly mode: "stub" | "engine";
  health(): Promise<Record<string, unknown>>;
  facts(scenario?: ScenarioName): Promise<FactsSnapshot>;
  listEvents(after?: string, limit?: number): Promise<FinanceEvent[]>;
  canIAfford(amount: number): Promise<CanIAffordResponse>;
  whatIf(scenario: Scenario): Promise<WhatIfResult>;
  plan(amount: number): Promise<Plan>;
  pending(): Promise<ProposalSummary | null>;
  accept(proposalId: string, via: "text" | "voice"): Promise<AcceptProposalResponse>;
  scenario(): ScenarioName;
  setScenario(name: ScenarioName): Promise<void>;
  addEvent(event: FinanceEvent): Promise<boolean>;
  reset(): Promise<void>;
  /** Present only in engine mode. */
  engine?: EngineOps;
}
