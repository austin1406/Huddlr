// Follow-ups on simulated time: a reminder when a proposal sits unanswered, and the emergency escalation that
// hands off to P4's voice agent by writing a call_requests row. Everything is checked again when it fires, so a
// YES, NO, or completed transfer in the meantime quietly cancels it.
import { toCallShortfall, toDollars, type FactsSnapshot, type ProposalService } from "../../contracts/src";
import { config } from "./character";
import type { Queryable } from "./db";
import { queueOutbox } from "./outbox";

const MIN = 60_000;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Called right after a proposal is created. An emergency (shortfall within 48 h) also gets an escalation check. */
export async function scheduleProposalFollowUps(
  db: Queryable,
  p: { userPhone: string; proposalId: number; now: Date; emergency: boolean },
): Promise<void> {
  const at = (minutes: number) => new Date(p.now.getTime() + minutes * MIN);
  const add = (kind: string, due: Date) =>
    db.query(
      "INSERT INTO follow_ups (user_phone, kind, proposal_id, due_at, created_sim_at) VALUES ($1, $2, $3, $4, $5)",
      [p.userPhone, kind, p.proposalId, due, p.now],
    );
  await add("proposal_reminder", at(config.proposals.reminder_after_minutes));
  if (p.emergency) await add("escalation_check", at(config.escalation.no_reply_cutoff_minutes));
}

export interface FollowUpResult {
  id: number;
  kind: string;
  outcome: "reminded" | "called" | "skipped";
}

/** Fires every follow-up that is due on the simulated clock. Each row is claimed once. */
export async function runFollowUps(deps: {
  db: Queryable;
  proposals: ProposalService & { get(id: number): Promise<{ status: string; action_text: string; amount_cents: number; expires_at: string } | null> };
  userPhone: string;
  now: Date;
  facts: FactsSnapshot;
}): Promise<FollowUpResult[]> {
  const { db, proposals, now, facts } = deps;
  await proposals.getPending(deps.userPhone); // expires stale proposals first, so a reminder never nags about a dead plan
  const due = await db.query<{ id: number; kind: string; proposal_id: number | null; user_phone: string }>(
    "UPDATE follow_ups SET status = 'done' WHERE status = 'pending' AND due_at <= $1 RETURNING id, kind, proposal_id, user_phone",
    [now],
  );
  const results: FollowUpResult[] = [];
  for (const f of due.rows) {
    const id = Number(f.id);
    const p = f.proposal_id != null ? await proposals.get(Number(f.proposal_id)) : null;
    const stillOpen = p?.status === "pending";
    const say = (key: string, text: string, priority: 0 | 1 | 2) =>
      queueOutbox(db, {
        idempotency_key: `followup:${id}:${key}`, user_phone: f.user_phone, speaker: "coach", text,
        thread_key: `proposal:${f.proposal_id}`, proposal_id: f.proposal_id == null ? null : Number(f.proposal_id), priority,
        created_sim_at: now.toISOString(),
      });

    if (f.kind === "proposal_reminder") {
      if (!stillOpen) { results.push({ id, kind: f.kind, outcome: "skipped" }); continue; }
      const until = new Date(p.expires_at).toLocaleTimeString("en-US", { timeZone: facts.timezone, hour: "numeric", minute: "2-digit" });
      // The Coach can't move money: the reminder is about making the move, not about replying YES.
      await say("reminder", `Quick nudge: still to do, ${p.action_text.charAt(0).toLowerCase()}${p.action_text.slice(1)} in your bank app. I'll check it off when I see the transfer${facts.shortfall?.within48Hours ? `; this one matters before ${until}` : ""}.`, facts.shortfall?.within48Hours ? 2 : 0);
      results.push({ id, kind: f.kind, outcome: "reminded" });
      continue;
    }

    if (f.kind === "escalation_check") {
      // Call only if the plan is still unanswered AND the shortfall is still real. A NO is respected: no call.
      if (!stillOpen || !facts.shortfall) { results.push({ id, kind: f.kind, outcome: "skipped" }); continue; }
      const s = facts.shortfall;
      const date = new Date(`${s.firstNegativeDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      const hint = `Checking goes ${usd(s.amount)} short on ${date}. Ask: will you ${p.action_text.replace(/^Move/, "move")} today? Only a clear yes counts.`;
      const call = await db.query(
        `INSERT INTO call_requests (user_phone, type, proposal_id, shortfall, script_hint, created_sim_at)
         VALUES ($1, 'emergency', $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [f.user_phone, Number(f.proposal_id), JSON.stringify(toCallShortfall(s)), hint, now],
      );
      if (call.rows[0]) await say("calling", `This one can't wait, so I'm going to give you a quick call about the ${usd(toDollars(p.amount_cents))} move.`, 2);
      results.push({ id, kind: f.kind, outcome: call.rows[0] ? "called" : "skipped" });
      continue;
    }
    results.push({ id, kind: f.kind, outcome: "skipped" });
  }
  return results;
}
