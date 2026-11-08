// One finance event -> a short group-chat debate in the outbox.
//
//   claim the event id (never react twice) -> moderator decides -> account characters and the Coach run in parallel
//   -> each account message is queued the moment it is ready -> the Coach (plan from P1's get_plan, plus a proposal
//   the user can say YES to) is queued last.
//
// Budgets: first message ~5 s, plan ~15 s (real clock, latency). Round 2 is skipped for now: one round fits the
// budget and keeps the chat quiet. Calendar decisions (quiet hours, cap) use the simulated clock.
import { localDate, type CharacterId, type FactsSnapshot, type FinanceEvent, type Plan, type ProposalService } from "../../contracts/src";
import { celebration, celebrationTiming } from "./celebrate";
import { describePriorities, fromFor, leadWith, loadPriorities, pickLine, type Priorities } from "./priorities";
import { character, config, speak, type SpeakResult } from "./character";
import type { Queryable } from "./db";
import type { Finance } from "./finance";
import { buildDigest, decide, type Decision } from "./moderator";
import { scheduleProposalFollowUps } from "./followups";
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

/**
 * The one transfer the user is asked to approve: a shortfall line if there is one (safety first), else the line the
 * user ranks highest (priorities), else P1's first line. A bonus is already in Checking, so for one (`windfall`)
 * Checking lines are "keep" lines and the money comes from Checking; otherwise a Checking top-up comes from Savings.
 */
export function proposalFromPlan(plan: Plan, priorities: Priorities | null = null, opts: { windfall?: boolean } = {}): { from: "checking" | "savings"; to: "checking" | "savings" | "card" | "car_loan" | "ira"; amount: number; actionText: string } | null {
  const line = pickLine(plan, priorities, opts);
  if (!line) return null;
  const to = line.destination as "checking" | "savings" | "card" | "car_loan" | "ira";
  const from = fromFor(line, opts.windfall ?? false) as "checking" | "savings";
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

/**
 * Which earlier message this one answers: one that opens by naming an earlier speaker ("Agreed with IRA on this one.",
 * "Adding to Checking:"). Only the first sentence counts, and the name must be capitalized, so "your card balance"
 * never threads under Card.
 */
export function answering(text: string, posted: Array<{ name: string; outboxId: number | null }>): number | null {
  const first = text.split(/(?<=[.!?:])\s/)[0] ?? text;
  if (!/\b(agree\w*|adding|add to|good point|building on|to add|point|like|as|with|on this)\b/i.test(first)) return null;
  const hit = [...posted].reverse().find((p) => p.outboxId != null && new RegExp(`\\b${p.name}\\b`).test(first));
  return hit?.outboxId ?? null;
}

/**
 * Accounts speak in turn, each hearing what was said before it. A reply that answers an earlier account threads
 * under that message (outbox.reply_to_outbox). The first speaker keeps the first-message budget; later ones get a
 * fresh short budget so the whole round still fits well inside the plan budget.
 */
async function speakInTurn(
  accounts: CharacterId[],
  started: number,
  say: (id: CharacterId, heard: Array<{ name: string; text: string }>, deadline: number) => Promise<SpeakResult>,
  queue: (id: CharacterId, text: string, replyToOutbox: number | null) => Promise<number | null>,
  onSpoken?: (id: CharacterId, r: SpeakResult) => void,
): Promise<Array<{ name: string; text: string }>> {
  const heard: Array<{ name: string; text: string }> = [];
  const posted: Array<{ name: string; outboxId: number | null }> = [];
  for (const [i, id] of accounts.entries()) {
    const deadline = i === 0
      ? started + config.debate.first_message_target_ms
      : Math.min(Date.now() + config.debate.first_message_target_ms, started + config.debate.plan_target_ms - 2000);
    const r = await say(id, [...heard], deadline);
    const name = character(id).name;
    const outboxId = await queue(id, r.text, answering(r.text, posted));
    heard.push({ name, text: r.text });
    posted.push({ name, outboxId });
    onSpoken?.(id, r);
  }
  return heard;
}

/** Did the crew react to a shortfall in the last 7 simulated days? Then money into Checking is a rescue worth cheering. */
async function hadRecentShortfall(db: Queryable, phone: string, now: Date): Promise<boolean> {
  const r = await db.query(
    "SELECT 1 FROM agent_event_reactions WHERE user_phone = $1 AND event_id LIKE 'evt_forecast_problem%' AND outcome = 'reacted' AND reacted_sim_at > $2::timestamptz - interval '7 days' LIMIT 1",
    [phone, now],
  );
  return r.rows.length > 0;
}

const situation = (id: CharacterId, event: FinanceEvent) =>
  id === "coach"
    ? `The accounts just explained what this means for them: ${event.type}. Close with the plan.`
    : `This just happened: ${event.type} ${JSON.stringify(event.data)}. Explain what it means for the user from your account's side, with one number. If you see it differently from another account, say so briefly and calmly.`;

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
  const sentToday = await proactiveSentToday(db, userPhone, now, facts.timezone);

  // A good move (saving, paying down debt, closing a gap) gets one cheer from the account it helped.
  const cheer = celebration(event, facts, await hadRecentShortfall(db, userPhone, now));
  if (cheer) {
    const timing = celebrationTiming({ now, timezone: facts.timezone, demoMode, proactiveSentToday: sentToday });
    result.decision = timing;
    result.reason = timing === "react" ? "celebration" : "celebration held (quiet hours or daily cap)";
    await db.query("UPDATE agent_event_reactions SET outcome = $2 WHERE event_id = $1", [event.id, timing === "react" ? "reacted" : "digested"]);
    if (timing === "react") {
      await queueOutbox(db, {
        idempotency_key: `evt:${event.id}:cheer`, user_phone: userPhone, speaker: cheer.speaker, text: cheer.text, thread_key: `evt:${event.id}`,
        event_id: event.id, priority: 0, created_sim_at: now.toISOString(),
      });
      result.firstMessageMs = Date.now() - started;
      result.messages.push({ speaker: cheer.speaker, source: "celebration", ms: result.firstMessageMs });
    }
    return result;
  }

  const decision = decide(event, {
    now, timezone: facts.timezone, demoMode, alreadyHandled: false, facts,
    proactiveSentToday: sentToday,
  });
  result.decision = decision.action;
  result.reason = decision.reason;
  const outcome = decision.action === "react" ? "reacted" : decision.action === "digest" ? "digested" : "skipped";
  await db.query("UPDATE agent_event_reactions SET outcome = $2 WHERE event_id = $1", [event.id, outcome]);
  if (decision.action !== "react") return result;

  const priority = decision.priority;
  const accounts = decision.speakers.filter((s) => s !== "coach");
  const withCoach = decision.speakers.includes("coach");
  const queue = (speaker: CharacterId, text: string, proposalId: number | null = null, replyToOutbox: number | null = null) =>
    queueOutbox(db, {
      idempotency_key: `evt:${event.id}:${speaker}`, user_phone: userPhone, speaker, text, thread_key: `evt:${event.id}`,
      event_id: event.id, proposal_id: proposalId, reply_to_outbox: replyToOutbox, priority, created_sim_at: now.toISOString(),
    });

  // The Coach's plan and proposal start now, in parallel with the accounts. Its line waits for the accounts,
  // so it can answer what they actually said (about a second, well inside the plan budget).
  const coachPrep = withCoach
    ? (async () => {
        const amount = planAmount(event, facts);
        const prefs = await loadPriorities(db, userPhone);
        const raw = amount ? await finance.plan(amount, { priorities: prefs }).catch(() => null) : null;
        const ask = raw ? proposalFromPlan(raw, prefs) : null;
        // The Coach sides with the line the YES moves (its "who is right" rule follows the first line).
        const plan = raw ? leadWith(raw, pickLine(raw, prefs)) : null;
        let proposalId: number | null = null;
        if (plan && ask) {
          const created = await proposals.create({ userPhone, plan, ...ask, sourceEventId: event.id });
          proposalId = created.proposal ? Number(created.proposal.id) : null;
          if (proposalId != null)
            await scheduleProposalFollowUps(db, { userPhone, proposalId, now, emergency: facts.shortfall?.within48Hours === true });
        }
        return { plan, ask, proposalId };
      })()
    : null;

  // Accounts, one after another so each hears the others; each is queued the moment it passes the checker.
  const heard = await speakInTurn(accounts, started,
    (id, heardSoFar, deadline) => speak(id, facts, situation(id, event), { event, model: deps.model, deadline, heard: heardSoFar }),
    (id, text, replyToOutbox) => queue(id, text, null, replyToOutbox),
    (id, r) => {
      result.firstMessageMs ??= Date.now() - started;
      result.messages.push({ speaker: id, source: r.source, ms: r.ms });
    });

  if (coachPrep) {
    const { plan, ask, proposalId } = await coachPrep;
    const line = await speak("coach", facts, situation("coach", event), {
      event, plan, ask: ask?.actionText ?? null, heard, model: deps.model, deadline: started + config.debate.plan_target_ms,
    });
    await queue("coach", line.text, proposalId);
    result.planMs = Date.now() - started;
    result.firstMessageMs ??= result.planMs;
    result.proposalId = proposalId;
    result.messages.push({ speaker: "coach", source: line.source, ms: line.ms });
  }
  return result;
}

const ACCOUNT_CHARACTERS = new Set<CharacterId>(["checking", "savings", "card", "car_loan", "ira"]);

/**
 * "I got a $600 bonus, what should I do?" by text: the same group debate an event gets, as a reply.
 * P1 plans for the amount first, so the account the plan favors is one of the two speakers (it can be "right"),
 * plus one rival; the Coach closes with the plan and a proposal the user can say YES to.
 * Replies don't count toward the daily cap or quiet hours (the user just asked), and there is no escalation call.
 */
export async function runWindfall(
  deps: Omit<DebateDeps, "clock">,
  ask: { inboundId: number; text: string; amount: number; label: string },
  now: Date,
): Promise<{ speakers: CharacterId[]; proposalId: number | null }> {
  const { db, finance, proposals, userPhone } = deps;
  const started = Date.now();
  const facts = await finance.facts();
  const event: FinanceEvent = {
    id: `chat_windfall_${ask.inboundId}`, type: "paycheck_landed", occurredAt: now.toISOString(), severity: "medium", accountId: null,
    data: { amount: ask.amount, label: ask.label },
  };

  const prefs = await loadPriorities(db, userPhone);
  const plan = await finance.plan(ask.amount, { priorities: prefs }).catch(() => null);
  // The bonus is already in Checking. A Checking line in P1's plan means "keep this much there" (it covers a gap),
  // not a transfer. The one thing to say YES to is the line that moves money OUT of Checking that the user ranks
  // highest (their priorities), else P1's first one.
  const keepLines = plan?.lines.filter((l) => l.destination === "checking" && l.amount > 0) ?? [];
  const main = plan ? pickLine(plan, prefs, { windfall: true }) : null;
  const moves = [
    ...(main ? [main] : []),
    ...(plan?.lines.filter((l) => l !== main && l.destination !== "checking" && !String(l.destination).startsWith("goal:") && l.amount > 0) ?? []),
  ];
  const keep = keepLines.reduce((s, l) => s + l.amount, 0);
  const mainTo = main ? (String(main.destination) as "savings" | "card" | "car_loan" | "ira") : null;
  const proposal = main && mainTo
    ? { from: "checking" as const, to: mainTo, amount: main.amount, actionText: `Move ${usd(main.amount)} from Checking to ${ACCOUNT_LABEL[mainTo]}` }
    : null;
  // The Coach sides with where the money goes; the "X is right" rule follows the plan's first line, so lead with the move.
  const coachPlan = plan && main ? { ...plan, lines: [...moves, ...keepLines] } : plan;
  const split = [
    ...(keep > 0 ? [`keep ${usd(keep)} in Checking${facts.shortfall ? " so you're not short before payday" : ""}`] : []),
    ...moves.map((m) => `move ${usd(m.amount)} to ${ACCOUNT_LABEL[String(m.destination)] ?? String(m.destination)}`),
  ].join(", and ");

  // Speakers: where the money goes, plus Checking if some of it stays there to cover a gap, else one rival.
  const rivals = (["savings", "card", "ira", "car_loan"] as CharacterId[]).filter((c) => c !== mainTo);
  const accounts = (mainTo ? [mainTo, ...(keep > 0 ? (["checking"] as CharacterId[]) : rivals)] : (["checking", "savings"] as CharacterId[]))
    .slice(0, config.moderator.max_speakers_per_event - 1);

  let proposalId: number | null = null;
  if (plan && proposal) {
    const created = await proposals.create({ userPhone, plan, ...proposal, sourceEventId: `chat_windfall_${ask.inboundId}` });
    proposalId = created.proposal ? Number(created.proposal.id) : null;
    if (proposalId != null) await scheduleProposalFollowUps(db, { userPhone, proposalId, now, emergency: false });
  }

  const queue = (speaker: CharacterId, text: string, pid: number | null = null, replyToOutbox: number | null = null, key: string = speaker) =>
    queueOutbox(db, {
      idempotency_key: `inbound:${ask.inboundId}:${key}`, user_phone: userPhone, speaker, text, reply_to: ask.inboundId,
      reply_to_outbox: replyToOutbox, thread_key: `inbound:${ask.inboundId}`, proposal_id: pid, priority: 1, created_sim_at: now.toISOString(),
    });

  // 1. The Coach answers the question first and says who's about to speak.
  const names = accounts.map((id) => character(id).name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  await queue("coach", `Good question. ${who} weigh${names.length > 1 ? "" : "s"} in, then my plan.`, null, null, "coach-open");

  // 2. Each account explains what the money would mean on its side, in turn, and can answer the others.
  const extraSources = [[ask.amount, keep], ...(plan ? [plan] : [])];
  const money = `The ${usd(ask.amount)} is new money that just landed in Checking (it is not coming out of Savings).`;
  const planNote = (id: CharacterId) => {
    const line = plan?.lines.find((l) => l.destination === id && l.amount > 0);
    if (!line) return "";
    const saved = Number((line.reasonNumbers as Record<string, unknown> | undefined)?.monthlyInterestSaved);
    return id === "checking"
      ? ` The plan keeps ${usd(line.amount)} of it in Checking so the balance doesn't go short before payday.`
      : ` The plan sends ${usd(line.amount)} to ${character(id).name}${saved > 0 ? `, which saves ${usd(saved)} a month in interest` : ""}.`;
  };
  const heard = await speakInTurn(accounts, started,
    (id, heardSoFar, deadline) =>
      speak(id, facts, `The user texted: "${ask.text}". ${money}${planNote(id)} Explain what this money would mean on your side, with one number.`, {
        event, model: deps.model, deadline, extraSources, heard: heardSoFar,
      }),
    (id, text, replyToOutbox) => queue(id, text, null, replyToOutbox));

  // 3. The Coach closes with the plan and the YES.
  let line: { text: string };
  if (proposalId != null)
    line = await speak("coach", facts, `The accounts just explained their side of the user's ${usd(ask.amount)}. ${money}${describePriorities(prefs) ? ` The user told us their priorities: ${describePriorities(prefs)}; the YES below follows them, so say so in a few words.` : ""} The plan: ${split}. Explain that split in plain words, naming each part with its own amount exactly as written here (no other amounts, no "remaining"), and why, then give the YES line.`, {
      event, plan: coachPlan, ask: proposal!.actionText, heard, model: deps.model, deadline: started + config.debate.plan_target_ms, extraSources,
    });
  else if (plan && !main && keep > 0)
    // Everything stays in Checking: nothing to move, so nothing to say YES to.
    line = { text: `Keep the whole ${usd(ask.amount)} in Checking for now${facts.shortfall ? `: you'd be short ${usd(facts.shortfall.amount)} before payday, and this covers it` : ""}. Nothing to move, so no YES needed.` };
  else
    // No new proposal could be made: never invite a YES here, it could approve something else.
    line = { text: `Good problem to have. I couldn't build a plan for the ${usd(ask.amount)} right now. Text me again in a minute and the crew will weigh in.` };
  await queue("coach", line.text, proposalId);
  return { speakers: [...accounts, "coach"], proposalId };
}

/** Reads new events from finance after the stored cursor and runs each one. The first call only records where "now" is. */
export async function pollEvents(deps: DebateDeps): Promise<DebateResult[]> {
  const cur = await deps.db.query<{ value: string }>("SELECT value FROM agent_state WHERE key = 'events_cursor'");
  const setCursor = (id: string) =>
    deps.db.query(
      `INSERT INTO agent_state (key, value) VALUES ('events_cursor', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [id],
    );
  if (!cur.rows[0]) {
    // First start or right after a reset: skip the backlog silently so the chat isn't flooded with old news.
    let last: string | undefined;
    for (let page = await deps.finance.events(); page.length; page = await deps.finance.events(last)) last = page.at(-1)!.id;
    await setCursor(last ?? "");
    return [];
  }
  const events = await deps.finance.events(cur.rows[0].value || undefined);
  const results: DebateResult[] = [];
  for (const event of events) {
    results.push(await runEvent(deps, event));
    await setCursor(event.id);
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
