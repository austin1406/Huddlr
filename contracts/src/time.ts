import { z } from "zod";
import { isoDateTime } from "./common";

/**
 * The clock rule. One row, `sim_state`, holds how far simulated time is from real time.
 * Calendar logic (bills, paychecks, forecast, proposal expiry, quiet hours, daily cap,
 * follow-ups, escalation cutoff, transaction dates) must call clock.now().
 * Delivery mechanics (typing gaps, retries, timeouts, polling, latency) use the real clock.
 */
export const SimState = z.object({
  /** Simulated time minus real time, in seconds. 0 means real time. */
  offsetSeconds: z.number().int(),
  /** Bypasses quiet hours, relaxes the daily cap, shortens typing gaps. Emergencies are unaffected. */
  demoMode: z.boolean(),
  updatedAt: isoDateTime,
});
export type SimState = z.infer<typeof SimState>;

/** Backed by the shared database row in production, by memory in tests. */
export interface SimStateStore {
  read(): Promise<SimState>;
  write(next: SimState): Promise<void>;
}

export class MemorySimStateStore implements SimStateStore {
  private state: SimState;
  constructor(initial?: SimState) {
    this.state = initial ?? { offsetSeconds: 0, demoMode: false, updatedAt: new Date().toISOString() };
  }
  async read(): Promise<SimState> {
    return this.state;
  }
  async write(next: SimState): Promise<void> {
    this.state = next;
  }
}

export class SimClock {
  private state: SimState;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: SimStateStore,
    private readonly realNow: () => number = Date.now,
  ) {
    this.state = { offsetSeconds: 0, demoMode: false, updatedAt: new Date(realNow()).toISOString() };
  }

  /** Load the latest offset and demo flag from the store. */
  async refresh(): Promise<SimState> {
    this.state = SimState.parse(await this.store.read());
    return this.state;
  }

  /** Keep the offset fresh in the background. Returns a function that stops it. */
  startAutoRefresh(intervalMs = 2000): () => void {
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
    return () => {
      if (this.timer) clearInterval(this.timer);
    };
  }

  /** Simulated "now": real time plus the offset, so time keeps ticking after a fast-forward. */
  now(): Date {
    return new Date(this.realNow() + this.state.offsetSeconds * 1000);
  }

  get demoMode(): boolean {
    return this.state.demoMode;
  }
}

/** Fast-forward by whole days. Used by the jump-days script and the demo controller. */
export async function jumpDays(store: SimStateStore, days: number, realNow: number = Date.now()): Promise<SimState> {
  const current = await store.read();
  const next: SimState = {
    ...current,
    offsetSeconds: current.offsetSeconds + Math.round(days * 86400),
    updatedAt: new Date(realNow).toISOString(),
  };
  await store.write(next);
  return next;
}

/** "2026-11-07" for the given instant in the customer's timezone. */
export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Hour of day, 0 to 23, in the customer's timezone. */
export function localHour(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")?.value) % 24;
}

export interface QuietHoursOptions {
  demoMode: boolean;
  /** True emergencies are never silenced. */
  emergency?: boolean;
  startHour?: number;
  endHour?: number;
}

/** Quiet hours default to 22:00 to 08:00 local time and wrap past midnight. */
export function isQuietHours(d: Date, timeZone: string, opts: QuietHoursOptions): boolean {
  if (opts.demoMode || opts.emergency) return false;
  const hour = localHour(d, timeZone);
  const start = opts.startHour ?? 22;
  const end = opts.endHour ?? 8;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}
