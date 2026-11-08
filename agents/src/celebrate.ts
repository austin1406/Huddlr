// Celebrations: when the user does something good with their money, the account it helped says so.
//
//   money into Savings / IRA, or a payment to the Card / Car Loan  -> that character cheers, with the new number
//   money into Checking that closes a recent shortfall              -> Checking says the gap is closed
//
// The text is built from the event and P1's facts only (no model call), so it is always grounded, instant, and
// works even when Gemini is rate-limited. Celebrations are friendly, not urgent: they respect quiet hours and the
// daily cap like any other proactive message, and they never react to the same event twice.
import { isQuietHours, type CharacterId, type FactsSnapshot, type FinanceEvent } from "../../contracts/src";
import { config } from "./character";

export interface Cheer {
  speaker: CharacterId;
  text: string;
}

const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const balance = (facts: FactsSnapshot, id: string) => facts.accounts.find((a) => a.id === id)?.balance;
const runway = (facts: FactsSnapshot) => facts.indicators.find((i) => i.id === "runway")?.value;

/**
 * The celebration for this event, or null if it isn't one (then the normal debate runs).
 * `recentShortfall` is true when a forecast_problem was handled in the last few days.
 */
export function celebration(event: FinanceEvent, facts: FactsSnapshot, recentShortfall: boolean): Cheer | null {
  if (event.type !== "user_transfer_seen") return null;
  const amount = Number(event.data.amount);
  if (!(amount > 0)) return null;
  const to = String(event.data.to ?? event.accountId ?? "");

  switch (to) {
    case "savings": {
      const months = runway(facts);
      return {
        speaker: "savings",
        text: `Yes! ${usd(amount)} just landed with me.${months != null ? ` That's ${months} months of essentials saved now.` : ""} Future you is breathing easier.`,
      };
    }
    case "card": {
      const owed = balance(facts, "card");
      return {
        speaker: "card",
        text: `You just paid me ${usd(amount)}.${owed != null ? ` I'm down to ${usd(owed)} owed.` : ""} Less interest for me to charge you. Respect.`,
      };
    }
    case "car_loan": {
      const owed = balance(facts, "car_loan");
      return {
        speaker: "car_loan",
        text: `Extra ${usd(amount)} toward the car.${owed != null ? ` ${usd(owed)} left to go.` : ""} Every extra payment shortens the road.`,
      };
    }
    case "ira":
      return { speaker: "ira", text: `${usd(amount)} planted for the long run. Give it a few decades and this one grows. Nice move.` };
    case "checking":
      // Money into Checking is only a win when it closed a real gap.
      if (!recentShortfall || facts.shortfall) return null;
      return {
        speaker: "checking",
        text: `${usd(amount)} landed and the gap is closed. No shortfall before payday anymore. Crisis averted, nice work.`,
      };
    default:
      return null;
  }
}

/** Live, or held for the evening digest? Same quiet hours and daily cap as the debates. */
export function celebrationTiming(ctx: { now: Date; timezone: string; demoMode: boolean; proactiveSentToday: number }): "react" | "digest" {
  const m = config.moderator;
  if (isQuietHours(ctx.now, ctx.timezone, { demoMode: ctx.demoMode, startHour: m.quiet_hours.start_hour, endHour: m.quiet_hours.end_hour })) return "digest";
  const cap: number = ctx.demoMode ? m.daily_cap_proactive_demo_mode : m.daily_cap_proactive;
  return ctx.proactiveSentToday + 1 > cap ? "digest" : "react";
}
