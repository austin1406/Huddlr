// One finance event -> a short group-chat debate in the outbox.
//
//   claim the event id (never react twice) -> moderator decides -> account characters and the Coach run in parallel
//   -> each account message is queued the moment it is ready -> the Coach (plan from P1's get_plan, plus a proposal
//   the user can say YES to) is queued last.
//
// Budgets: first message ~5 s, plan ~15 s (real clock, latency). Round 2 is skipped for now: one round fits the
// budget and keeps the chat quiet. Calendar decisions (quiet hours, cap) use the simulated clock.
import { localDate, type CharacterId, type FactsSnapshot, type FinanceEvent, type Plan, type ProposalService } from "../../contracts/src";
import { config, speak } from "./character";
import type { Queryable } from "./db";
import type { Finance } from "./finance";
import { buildDigest, decide, type Decision } from "./moderator";
import { queueOutbox } from "./outbox";

export interface DebateDeps {
  db: Queryable;
  finance: Finance;
  proposals: ProposalService;
  userPhone: string;
  /** Simulated clock reading. */
  clock: () => Promise<{ now: Date; demoMode: boolean }>;
  /** Replaces Gemini in tests. */
  model?: (prompt: string) => Promise<string>;
}

export interface DebateResult {
  eventId: string;
  decision: Decision["action"] | "duplicate";
  reason: string;
  messages: Array<{ speaker: CharacterId; source: string; ms: number }>;
  proposalId: number | null;
  firstMessageMs: number | null;
  planMs: number | null;
}

const ACCOUNT_LABEL: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Car Loan", ira: "IRA" };
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** How much money the Coach is planning for. Null means comment only, no plan. */
export function planAmount(event: FinanceEvent, facts: FactsSnapshot): number | null {
  if (facts.shortfall) return facts.shortfall.suggestedTransfer;
  if (event.type === "paycheck_landed" && facts.forecast.safeToSpendUntilPayday > 0) return facts.forecast.safeToSpendUntilPayday;
  return null;
}

/** The first plan line becomes the one transfer the user is asked to approve. Money into Checking comes from Savings; everything else from Checking. */
export function proposalFromPlan(plan: Plan): { from: "checking" | "savings"; to: "checking" | "savings" | "card" | "car_loan" | "ira"; amount: number; actionText: string } | null {
  const line = plan.lines.find((l) => !String(l.destination).startsWith("goal:") && l.amount > 0);
  if (!line) return null;
  const to = line.destination as "checking" | "savings" | "card" | "car_loan" | "ira";
  const from = to === "checking" ? "savings" : "checking";
  return { from, to, amount: line.amount, actionText: `Move ${usd(line.amount)} from ${ACCOUNT_LABEL[from]} to ${ACCOUNT_LABEL[to]}` };
}

/** Proactive messages already queued today (simulated local day). Replies and emergencies don't count toward the cap. */
async function proactiveSentToday(db: Queryable, phone: string, now: Date, timezone: string): Promise<number> {
  const r = await db.query<{ created_sim_at: string | Date }>(
    "SELECT created_sim_at FROM outbox WHERE user_phone = $1 AND priority = 0 AND created_sim_at > $2::timestamptz - interval '36 hours'",
    [phone, now],
  );
  const today = localDate(now, timezone);
  return r.rows.filter((row) => localDate(new Date(row.created_sim_at), timezone) === today).length;
}

const situation = (id: CharacterId, event: FinanceEvent) =>
  id === "coach"
    ? `The accounts just reacted to this: ${event.type}. Settle it with the plan.`
    : `This just happened: ${event.type} ${JSON.stringify(event.data)}. React in character from your account's point of view. Disagree with the others if your account would.`;

export async function runEvent(deps: DebateDeps, event: FinanceEvent): Promise<DebateResult> {
  const { db, finance, proposals, userPhone } = deps;
  const started = Date.now();
  const { now, demoMode } = await deps.clock();
  const result: DebateResult = { eventId: event.id, decision: "skip", reason: "", messages: [], proposalId: null, firstMessageMs: null, planMs: null };

  // Claim first, so a restart or a second worker can never react to the same event id twice.
  const claim = await db.query(
    "INSERT INTO agent_event_reactions (event_id, user_phone, outcome, reacted_sim_at, event) VALUES ($1, $2, 'skipped', $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
    [event.id, userPhone, now, JSON.stringify(event)],
  );
  if (!claim.rows[0]) return { ...result, decision: "duplicate", reason: "already handled" };

  const facts = await finance.facts();
  const decision = decide(event, {
    now, timezone: facts.timezone, demoMode, alreadyHandled: false, facts,
    proactiveSentToday: await proactiveSentToday(db, userPhone, now, facts.timezone),
  });
  result.decision = decision.action;
  result.reason = decision.reason;
  const outcome = decision.action === "react" ? "reacted" : decision.action === "digest" ? "digested" : "skipped";
  await db.query("UPDATE agent_event_reactions SET outcome = $2 WHERE event_id = $1", [event.id, outcome]);
  if (decision.action !== "react") return result;

  const priority = decision.priority;
  const accounts = decision.speakers.filter((s) => s !== "coach");
  const withCoach = decision.speakers.includes("coach");
  const queue = (speaker: CharacterId, text: string, proposalId: number | null = null) =>
    queueOutbox(db, {
      idempotency_key: `evt:${event.id}:${speaker}`, user_phone: userPhone, speaker, text, thread_key: `evt:${event.id}`,
      event_id: event.id, proposal_id: proposalId, priority, created_sim_at: now.toISOString(),
    });

  // Coach work starts now, in parallel with the accounts: plan, proposal, then its line.
  const coachWork = withCoach
    ? (async () => {
        const amount = planAmount(event, facts);
        const plan = amount ? await finance.plan(amount).catch(() => null) : null;
        const ask = plan ? proposalFromPlan(plan) : null;
        let proposalId: number | null = null;
        if (plan && ask) {
          const created = await proposals.create({ userPhone, plan, ...ask, sourceEventId: event.id });
          proposalId = created.proposal ? Number(created.proposal.id) : null;
        }
        const line = await speak("coach", facts, situation("coach", event), {
          event, plan, ask: ask?.actionText ?? null, model: deps.model, deadline: started + config.debate.plan_target_ms,
        });
        return { line, proposalId };
      })()
    : null;

  // Accounts: queue each one the moment it passes the checker.
  await Promise.all(
    accounts.map(async (id) => {
      const r = await speak(id, facts, situation(id, event), { event, model: deps.model, deadline: started + config.debate.first_message_target_ms });
      await queue(id, r.text);
      result.firstMessageMs ??= Date.now() - started;
      result.messages.push({ speaker: id, source: r.source, ms: r.ms });
    }),
  );

  if (coachWork) {
    const { line, proposalId } = await coachWork;
    await queue("coach", line.text, proposalId);
    result.planMs = Date.now() - started;
    result.firstMessageMs ??= result.planMs;
    result.proposalId = proposalId;
    result.messages.push({ speaker: "coach", source: line.source, ms: line.ms });
  }
  return result;
}

/** Reads new events from finance after the stored cursor and runs each one. Returns what happened. */
export async function pollEvents(deps: DebateDeps): Promise<DebateResult[]> {
  const cur = await deps.db.query<{ value: string }>("SELECT value FROM agent_state WHERE key = 'events_cursor'");
  const events = await deps.finance.events(cur.rows[0]?.value);
  const results: DebateResult[] = [];
  for (const event of events) {
    results.push(await runEvent(deps, event));
    await deps.db.query(
      `INSERT INTO agent_state (key, value) VALUES ('events_cursor', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [event.id],
    );
  }
  return results;
}

/**
 * Evening digest: once per simulated local day, at or after digest_time, one Coach message covering the events
 * that were held back (quiet hours, cap, low severity). Returns true if it queued one.
 */
export async function maybeSendDigest(deps: DebateDeps, timezone: string): Promise<boolean> {
  const { now, demoMode } = await deps.clock();
  const [hh, mm] = String(config.moderator.digest_time).split(":").map(Number);
  const local = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const minutes = Number(local.find((p) => p.type === "hour")?.value) * 60 + Number(local.find((p) => p.type === "minute")?.value);
  if (!demoMode && minutes < hh * 60 + mm) return false;

  const today = localDate(now, timezone);
  const r = await deps.db.query<{ event: FinanceEvent | string; reacted_sim_at: string | Date }>(
    "SELECT event, reacted_sim_at FROM agent_event_reactions WHERE user_phone = $1 AND outcome = 'digested' AND event IS NOT NULL ORDER BY reacted_sim_at",
    [deps.userPhone],
  );
  const held = r.rows
    .filter((row) => localDate(new Date(row.reacted_sim_at), timezone) === today)
    .map((row) => (typeof row.event === "string" ? JSON.parse(row.event) : row.event) as FinanceEvent);
  const text = buildDigest(held);
  if (!text) return false;
  const id = await queueOutbox(deps.db, {
    idempotency_key: `digest:${deps.userPhone}:${today}`, user_phone: deps.userPhone, speaker: "coach", text,
    thread_key: `digest:${today}`, priority: 0, created_sim_at: now.toISOString(),
  });
  return id != null;
}
