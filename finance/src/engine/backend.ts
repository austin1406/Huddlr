import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SimClock, localDate, type AccountId, type FactsSnapshot, type FinanceEvent, type Persona, type Scenario, type SimStateStore } from "../../../contracts/src";
import type { AdminState, Backend, BillOp, EngineOps, PurchaseOp } from "../backend";
import type { ScenarioName } from "../env";
import { findMatchingProposal, type ProposalGateway } from "../proposals";
import { canIAfford } from "./afford";
import { addDays, r2 } from "./calendar";
import { EventLog, detectEvents } from "./events";
import { buildFacts } from "./facts";
import type { SourceTxn, TxnSource } from "../nessie/source";
import { createLedger, postBill, postDeposit, postPaycheck, postPurchase, postTransfer, postWithdrawal, settleThrough, type LedgerOverrides, type LedgerState, type Txn } from "./ledger";
import { planV1, type PlanVersion } from "./optimizer";
import { planV0 } from "./plan";
import { whatIf } from "./whatif";

interface Saved {
  ledger: LedgerState;
  events: FinanceEvent[];
  scenario: ScenarioName;
}

export interface EngineOptions {
  persona: Persona;
  store: SimStateStore;
  gateway: ProposalGateway;
  /** JSON file that keeps the ledger and event log across restarts. Omit for in-memory (tests). */
  dataFile?: string;
  realNow?: () => number;
  /** Which plan optimizer answers get_plan. Default v1. */
  planVersion?: PlanVersion;
  /** The transaction log (Nessie). Without one the engine runs on the persona alone. */
  source?: TxnSource;
  /** Why a configured source is not in use, shown in /health. */
  sourceError?: string;
}

/** How often the transaction log is read, in real milliseconds. */
export const SOURCE_POLL_MS = 30_000;

const PAYCHECK = /pay(check|roll)|salary|direct dep/i;
const ROUTE = /(checking|savings|card|car_loan|ira)\s*->\s*(checking|savings|card|car_loan|ira)/i;

const SHORTFALL_START: LedgerOverrides = { checking: 33, lastPaidDaysAgo: 12 };

/**
 * The real finance engine over the persona customer's ledger. Every calendar decision uses the shared
 * SimClock (real time plus the sim_state offset), so jumping days settles bills and paychecks for the days
 * that passed. Operations run one at a time so a request never sees a half-applied change.
 */
export class EngineBackend implements Backend, EngineOps {
  readonly mode = "engine" as const;
  readonly engine: EngineOps = this;

  private ledger: LedgerState;
  private log: EventLog;
  private current: ScenarioName = "normal";
  private lock: Promise<unknown> = Promise.resolve();
  private readonly clock: SimClock;

  private constructor(
    private readonly o: EngineOptions,
    ledger: LedgerState,
    log: EventLog,
  ) {
    this.ledger = ledger;
    this.log = log;
    this.planVersion = o.planVersion ?? "v1";
    this.clock = new SimClock(o.store, o.realNow);
  }

  static async create(o: EngineOptions): Promise<EngineBackend> {
    const clock = new SimClock(o.store, o.realNow);
    await clock.refresh();
    const saved = o.dataFile ? EngineBackend.load(o.dataFile) : null;
    const today = localDate(clock.now(), o.persona.customer.timezone);
    const backend = new EngineBackend(o, saved?.ledger ?? createLedger(o.persona, today), new EventLog(saved?.events ?? []));
    backend.current = saved?.scenario ?? "normal";
    await backend.exclusive(async () => {
      await backend.sync();
      backend.save();
    });
    return backend;
  }

  private static load(file: string): Saved | null {
    try {
      if (!existsSync(file)) return null;
      const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
      return saved.ledger?.version === 1 ? saved : null;
    } catch (err) {
      console.warn(`[finance] could not read ${file}, starting fresh: ${(err as Error).message}`);
      return null;
    }
  }

  private save(): void {
    if (!this.o.dataFile) return;
    mkdirSync(dirname(this.o.dataFile), { recursive: true });
    const tmp = `${this.o.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ledger: this.ledger, events: this.log.all(), scenario: this.current } satisfies Saved));
    renameSync(tmp, this.o.dataFile);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Catch the ledger up to the simulated clock and log anything newly notable. Returns the facts without proposals. */
  private async sync(): Promise<{ now: Date; today: string; facts: FactsSnapshot }> {
    await this.clock.refresh();
    const now = this.clock.now();
    const persona = this.o.persona;
    const today = localDate(now, persona.customer.timezone);
    settleThrough(this.ledger, persona, today);
    let changed = await this.pollSource(today, now.toISOString());
    const bare = buildFacts(this.ledger, persona, now);
    for (const e of detectEvents(this.ledger, persona, bare)) {
      if (this.log.has(e.id)) continue;
      if (e.type === "user_transfer_seen") {
        const matched = await this.watchTransfer(String(e.data.txnId));
        e.data.matchedProposalId = matched ?? null;
      }
      this.log.add(e);
      changed = true;
    }
    changed = (await this.retryUnresolvedTransfers()) || changed;
    if (changed) this.save();
    return { now, today, facts: { ...bare, recentEvents: this.log.recent(5) } };
  }

  /**
   * The transfer watcher. A transfer the user made that fulfils an open proposal (same accounts, at least the
   * amount) is reported to the agents service, which marks the proposal completed and has the Coach close the loop.
   * Returns the proposal id, null when nothing matched, or undefined when the agents service could not be asked
   * (the transfer stays unresolved and is retried).
   */
  private async watchTransfer(txnId: string): Promise<string | null | undefined> {
    const txn = this.ledger.txns.find((t) => t.id === txnId);
    const done = (this.ledger.completed ??= {});
    if (!txn || !txn.from || !txn.to) return null;
    if (done[txnId] !== undefined) return done[txnId];
    try {
      const match = findMatchingProposal({ from: txn.from, to: txn.to, amount: txn.amount }, await this.o.gateway.open());
      const completed = match ? await this.o.gateway.complete(match.id, txn.id) : false;
      done[txnId] = match && completed ? match.id : null;
      return done[txnId];
    } catch (err) {
      console.warn(`[finance] transfer ${txnId} not matched yet, will retry: ${(err as Error).message}`);
      return undefined;
    }
  }

  private planVersion: PlanVersion;

  setPlanVersion(version: PlanVersion): PlanVersion {
    this.planVersion = version;
    return version;
  }

  private lastPollAt = 0;
  private lastSourceError: string | undefined;

  /**
   * Reads the transaction log. The first successful read is recorded as history and applies nothing. After that,
   * any record id not seen before is new and is applied to the ledger. New items are found by id, never by date.
   */
  private async pollSource(today: string, nowIso: string): Promise<boolean> {
    const source = this.o.source;
    if (!source) return false;
    const realNow = (this.o.realNow ?? Date.now)();
    if (realNow - this.lastPollAt < SOURCE_POLL_MS) return false;
    this.lastPollAt = realNow;
    let all: SourceTxn[];
    try {
      all = await source.fetchAll();
      this.lastSourceError = undefined;
    } catch (err) {
      this.lastSourceError = (err as Error).message;
      console.warn(`[finance] ${source.name} unreachable, keeping the current ledger: ${this.lastSourceError}`);
      return false;
    }
    const seen = (this.ledger.sourceSeen ??= {});
    if (!this.ledger.sourceBaselined) {
      for (const t of all) seen[t.id] = true;
      this.ledger.sourceBaselined = true;
      return true;
    }
    const fresh = all.filter((t) => !seen[t.id]).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id));
    for (const t of fresh) {
      seen[t.id] = true;
      this.applyFromSource(t, today, nowIso);
    }
    return true;
  }

  /** Turns a new transaction-log record into a ledger change. Records we cannot interpret are skipped with a warning. */
  private applyFromSource(t: SourceTxn, today: string, nowIso: string): void {
    const origin = { id: `nessie-${t.id}`, date: t.date && t.date <= today ? t.date : today };
    const ledger = this.ledger;
    if (t.kind === "purchase" && (t.account === "checking" || t.account === "card")) {
      postPurchase(ledger, today, nowIso, { amount: t.amount, merchant: t.description || "Purchase", category: "other", account: t.account, ...origin });
    } else if (t.kind === "deposit" && t.account === "checking") {
      if (PAYCHECK.test(t.description)) postPaycheck(ledger, today, nowIso, t.amount, origin);
      else postDeposit(ledger, today, nowIso, t.amount, t.description || "Deposit", origin);
    } else if (t.kind === "withdrawal" && t.account === "checking") {
      postWithdrawal(ledger, today, nowIso, t.amount, t.description || "Withdrawal", origin);
    } else if (t.kind === "transfer") {
      const route = ROUTE.exec(t.description);
      if (route) postTransfer(ledger, today, nowIso, route[1]!.toLowerCase() as AccountId, route[2]!.toLowerCase() as AccountId, t.amount, origin);
      else console.warn(`[finance] transfer ${t.id} has no "from->to" in its description, skipped`);
    } else if (t.kind === "bill") {
      const known = this.o.persona.recurringBills.some((b) => b.id === t.nickname);
      if (!known && t.status !== "completed" && t.date && t.date >= today) postBill(ledger, { id: origin.id, label: t.description || "Bill", amount: t.amount, dueDate: t.date });
    } else {
      console.warn(`[finance] ${t.kind} ${t.id} on ${t.account} is not used by the engine, skipped`);
    }
  }

  /**
   * Writes a user action to the transaction log first, and remembers its id so the next read does not apply it twice.
   * If the log cannot be written the action still happens locally (the engine is the source of truth for the demo).
   */
  private async record(write: (source: TxnSource) => Promise<string>): Promise<string | undefined> {
    const source = this.o.source;
    if (!source) return undefined;
    try {
      const id = await write(source);
      (this.ledger.sourceSeen ??= {})[id] = true;
      return `nessie-${id}`;
    } catch (err) {
      console.warn(`[finance] could not write to ${source.name}, applying locally only: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Read the transaction log now instead of waiting for the next poll. */
  async refresh(): Promise<void> {
    await this.exclusive(async () => {
      this.lastPollAt = 0;
      await this.sync();
      this.save();
    });
  }

  private lastRetryAt = 0;

  /** Transfers the watcher could not resolve are tried again, at most every 15 real seconds. */
  private async retryUnresolvedTransfers(): Promise<boolean> {
    const done = (this.ledger.completed ??= {});
    const waiting = this.ledger.txns.filter((t) => t.kind === "transfer" && done[t.id] === undefined && this.log.has(`evt_user_transfer_seen_${t.id}`));
    const realNow = (this.o.realNow ?? Date.now)();
    if (waiting.length === 0 || realNow - this.lastRetryAt < 15_000) return false;
    this.lastRetryAt = realNow;
    let changed = false;
    for (const t of waiting) {
      const matched = await this.watchTransfer(t.id);
      if (matched === undefined) continue;
      const event = this.log.get(`evt_user_transfer_seen_${t.id}`);
      if (event) event.data.matchedProposalId = matched;
      changed = true;
    }
    return changed;
  }

  /** Runs `fn` with the ledger caught up, then saves and re-detects so a change shows up as events immediately. */
  private mutate<T>(fn: (ctx: { now: Date; today: string }) => T | Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const ctx = await this.sync();
      const result = await fn(ctx);
      await this.sync();
      this.save();
      return result;
    });
  }

  // ---- Backend

  async health() {
    const sourceError = this.o.sourceError ?? this.lastSourceError;
    return { ok: true, service: "finance", mode: "engine", source: this.o.source?.name ?? "persona", ...(sourceError ? { sourceError } : {}) };
  }

  async facts(): Promise<FactsSnapshot> {
    const pending = await this.o.gateway.pending();
    return this.exclusive(async () => {
      const { facts } = await this.sync();
      return { ...facts, pendingProposals: pending ? [pending] : [] };
    });
  }

  async listEvents(after?: string, limit = 50) {
    return this.exclusive(async () => {
      await this.sync();
      return this.log.after(after, limit);
    });
  }

  async canIAfford(amount: number) {
    return this.exclusive(async () => canIAfford((await this.sync()).facts, amount));
  }

  async whatIf(scenario: Scenario) {
    return this.exclusive(async () => {
      const { now } = await this.sync();
      return whatIf(this.ledger, this.o.persona, now, scenario);
    });
  }

  async plan(amount: number) {
    return this.exclusive(async () => {
      const { facts } = await this.sync();
      return this.planVersion === "v0" ? planV0(facts, amount) : planV1(facts, this.o.persona.goals, amount);
    });
  }

  pending() {
    return this.o.gateway.pending();
  }

  accept(proposalId: string, via: "text" | "voice") {
    return this.o.gateway.accept(proposalId, via);
  }

  scenario(): ScenarioName {
    return this.current;
  }

  /** normal: Maya's ordinary week. shortfall: checking $33 with payday 2 days away, so a $143 gap opens at once. */
  async setScenario(name: ScenarioName) {
    await this.restart(name === "shortfall" ? SHORTFALL_START : {}, name);
  }

  async addEvent(event: FinanceEvent) {
    return this.exclusive(async () => {
      const added = this.log.add(event);
      if (added) this.save();
      return added;
    });
  }

  /** Back to the start: persona balances, empty history, clock offset 0, demo mode off. */
  async reset() {
    await this.restart({}, "normal");
  }

  private async restart(overrides: LedgerOverrides, scenario: ScenarioName) {
    await this.exclusive(async () => {
      await this.o.store.write({ offsetSeconds: 0, demoMode: false, updatedAt: new Date((this.o.realNow ?? Date.now)()).toISOString() });
      await this.clock.refresh();
      const today = localDate(this.clock.now(), this.o.persona.customer.timezone);
      this.ledger = createLedger(this.o.persona, today, overrides);
      this.log = new EventLog();
      this.current = scenario;
      this.lastPollAt = 0; // the log's current contents become history again
      await this.sync();
      this.save();
    });
  }

  // ---- EngineOps

  async state(): Promise<AdminState> {
    return this.exclusive(async () => {
      const { now, today } = await this.sync();
      return {
        sim: await this.o.store.read(),
        now: now.toISOString(),
        today,
        balances: { ...this.ledger.balances },
        lastPaid: this.ledger.lastPaid,
        settledThrough: this.ledger.settledThrough,
        unpaidOneOffBills: this.ledger.oneOffBills.filter((b) => !b.paid).map(({ id, label, amount, dueDate }) => ({ id, label, amount, dueDate })),
        txnCount: this.ledger.txns.length,
        eventCount: this.log.all().length,
        recentTxns: this.ledger.txns.filter((t) => t.kind !== "daily").slice(-5),
        planVersion: this.planVersion,
        source: {
          name: this.o.source?.name ?? "persona",
          baselined: this.ledger.sourceBaselined ?? false,
          recordsSeen: Object.keys(this.ledger.sourceSeen ?? {}).length,
          ...(this.o.sourceError || this.lastSourceError ? { error: this.o.sourceError ?? this.lastSourceError } : {}),
        },
      };
    });
  }

  /** Fast-forward whole days (the jump-days script). Days between are settled the next time anything reads. */
  async jumpDays(days: number) {
    return this.exclusive(async () => {
      const current = await this.o.store.read();
      const next = { ...current, offsetSeconds: current.offsetSeconds + Math.round(days * 86400), updatedAt: new Date((this.o.realNow ?? Date.now)()).toISOString() };
      await this.o.store.write(next);
      await this.sync();
      this.save();
      return next;
    });
  }

  async setDemoMode(on: boolean) {
    return this.exclusive(async () => {
      const next = { ...(await this.o.store.read()), demoMode: on, updatedAt: new Date((this.o.realNow ?? Date.now)()).toISOString() };
      await this.o.store.write(next);
      return next;
    });
  }

  purchase(op: PurchaseOp): Promise<Txn> {
    return this.mutate(async ({ now, today }) => {
      const id = await this.record((src) =>
        src.recordPurchase({ account: op.account ?? "checking", amount: op.amount, merchant: op.merchant ?? "Purchase", category: op.category ?? "shopping", date: today }),
      );
      return postPurchase(this.ledger, today, now.toISOString(), { ...op, id });
    });
  }

  transfer(from: AccountId, to: AccountId, amount: number): Promise<Txn> {
    return this.mutate(async ({ now, today }) => {
      const id = await this.record((src) => src.recordTransfer({ from, to, amount, date: today }));
      return postTransfer(this.ledger, today, now.toISOString(), from, to, amount, { id });
    });
  }

  paycheck(amount?: number): Promise<Txn> {
    return this.mutate(async ({ now, today }) => {
      const id = await this.record((src) => src.recordDeposit({ amount: amount ?? this.ledger.paycheckAmount, description: "Paycheck", date: today }));
      return postPaycheck(this.ledger, today, now.toISOString(), amount, { id });
    });
  }

  bill(op: BillOp) {
    return this.mutate(async ({ today }) => {
      const dueDate = op.dueDate ?? addDays(today, op.dueInDays ?? 2);
      const id = await this.record((src) => src.recordBill({ label: op.label, amount: op.amount, dueDate }));
      const bill = postBill(this.ledger, { id, label: op.label, amount: r2(op.amount), dueDate, essential: op.essential });
      return { id: bill.id, label: bill.label, amount: bill.amount, dueDate: bill.dueDate };
    });
  }
}
