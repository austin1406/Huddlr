// Moderator v0: decides whether an event gets a live reaction, goes to the evening digest, or is skipped,
// and who speaks. Pure function of (event, context) so it is easy to test. Calendar logic uses the
// simulated now() passed in ctx.now (from SimClock), never Date.now().
import { isQuietHours, localHour, type CharacterId, type FinanceEvent, type FactsSnapshot } from "../../contracts/src";
import { cast, config } from "./character";

export interface ModeratorContext {
  /** SimClock.now() */
  now: Date;
  timezone: string;
  demoMode: boolean;
  /** Proactive messages already sent today (simulated local day). Replies to the user don't count. */
  proactiveSentToday: number;
  /** True if agent_event_reactions already has this event id. */
  alreadyHandled: boolean;
  /** Facts at decision time, used to spot a real emergency. */
  facts?: FactsSnapshot;
}

export type Decision =
  | { action: "react"; speakers: CharacterId[]; priority: 0 | 2; reason: string }
  | { action: "digest"; reason: string }
  | { action: "skip"; reason: string };

/** Events where the Coach should close with a plan. */
const PLAN_EVENTS = new Set<FinanceEvent["type"]>(["big_purchase", "paycheck_landed", "forecast_problem"]);

export function isEmergency(event: FinanceEvent, facts?: FactsSnapshot): boolean {
  return event.type === "forecast_problem" && (event.severity === "high" || facts?.shortfall?.within48Hours === true);
}

/** Who speaks: the account the event touched first, then other interested accounts, Coach last. Max 3 total. */
export function pickSpeakers(event: FinanceEvent): CharacterId[] {
  const max: number = config.moderator.max_speakers_per_event;
  const withCoach = PLAN_EVENTS.has(event.type) && config.moderator.coach_always_speaks_when_plan;
  const accounts = cast.filter((c) => c.id !== "coach");
  const owner = accounts.find((c) => c.account === event.accountId);
  const interested = accounts.filter((c) => c !== owner && c.speaks_on.includes(event.type));
  const picked = [owner, ...interested].filter((c): c is (typeof accounts)[number] => !!c).map((c) => c.id);
  const room = withCoach ? max - 1 : max;
  return [...picked.slice(0, room), ...(withCoach ? (["coach"] as CharacterId[]) : [])];
}

export function decide(event: FinanceEvent, ctx: ModeratorContext): Decision {
  if (ctx.alreadyHandled) return { action: "skip", reason: "already handled this event id" };

  const speakers = pickSpeakers(event);
  if (speakers.length === 0) return { action: "skip", reason: `nobody speaks on ${event.type}` };

  // Emergencies ignore quiet hours and the cap in every mode.
  if (isEmergency(event, ctx.facts)) return { action: "react", speakers, priority: 2, reason: "emergency" };

  if (isQuietHours(ctx.now, ctx.timezone, { demoMode: ctx.demoMode, startHour: config.moderator.quiet_hours.start_hour, endHour: config.moderator.quiet_hours.end_hour }))
    return { action: "digest", reason: `quiet hours (local hour ${localHour(ctx.now, ctx.timezone)})` };

  const cap: number = ctx.demoMode ? config.moderator.daily_cap_proactive_demo_mode : config.moderator.daily_cap_proactive;
  if (ctx.proactiveSentToday + speakers.length > cap)
    return { action: "digest", reason: `daily cap (${ctx.proactiveSentToday}/${cap} sent)` };

  if (event.severity === "low" && !ctx.demoMode) return { action: "digest", reason: "low severity" };

  return { action: "react", speakers, priority: 0, reason: "relevant" };
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DIGEST_LABEL: Record<FinanceEvent["type"], (e: FinanceEvent) => string> = {
  big_purchase: (e) => `${e.data.merchant ?? "a purchase"} for ${usd(Number(e.data.amount))}`,
  paycheck_landed: (e) => `a paycheck of ${usd(Number(e.data.amount))} landed`,
  bill_due_soon: (e) => `${e.data.billId ?? "a bill"} of ${usd(Number(e.data.amount))} is due soon`,
  forecast_problem: () => `the forecast needs a look`,
  user_transfer_seen: (e) => `you moved ${usd(Number(e.data.amount))}`,
  p2p_imbalance: () => `a friend payment is still open`,
};

/** One evening message for everything held back today. Built from event data only, so it is grounded. */
export function buildDigest(events: FinanceEvent[]): string | null {
  if (events.length === 0) return null;
  const items = events.map((e) => DIGEST_LABEL[e.type](e));
  return `Today's recap: ${items.join("; ")}. Reply if you want the crew to weigh in on any of it.`;
}
