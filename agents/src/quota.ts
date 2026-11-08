// Knows when Gemini's rate limit is used up, so it can be logged and shown instead of failing silently.
// Gemini returns HTTP 429 with google.rpc details: a QuotaFailure naming the limit (…PerMinute… or …PerDay…)
// and a RetryInfo delay. The free tier publishes no remaining-quota headers, so a 429 is the only signal.

export type QuotaScope = "minute" | "day" | "unknown";

export class QuotaError extends Error {
  constructor(
    readonly scope: QuotaScope,
    /** Seconds Gemini asked us to wait, if it said. */
    readonly retryAfterSeconds: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** Reads a Gemini 429 body. Unknown shapes still become a QuotaError so callers can react. */
export function parseQuotaError(body: string): QuotaError {
  let details: Array<Record<string, unknown>> = [];
  let message = body.slice(0, 200);
  try {
    const j = JSON.parse(body) as { error?: { message?: string; details?: Array<Record<string, unknown>> } };
    details = j.error?.details ?? [];
    message = j.error?.message ?? message;
  } catch { /* not JSON */ }
  const ids = details
    .flatMap((d) => (Array.isArray(d.violations) ? (d.violations as Array<Record<string, unknown>>) : []))
    .map((v) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`)
    .join(" ");
  const haystack = `${ids} ${message}`;
  const scope: QuotaScope = /per ?day|daily/i.test(haystack) ? "day" : /per ?minute|per_minute/i.test(haystack) ? "minute" : "unknown";
  const delay = details.find((d) => typeof d.retryDelay === "string")?.retryDelay as string | undefined;
  const retry = delay ? Number.parseFloat(delay) : null;
  return new QuotaError(scope, Number.isFinite(retry) ? retry : null, message);
}

/** When the free tier's daily limit resets: midnight Pacific. */
export function nextDailyReset(from = new Date()): Date {
  const pt = new Date(from.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = from.getTime() - pt.getTime();
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  return new Date(midnight.getTime() + offset);
}

export interface QuotaStatus {
  ok: boolean;
  scope: QuotaScope | null;
  /** Real-clock time Gemini should work again (delivery timing, not the simulated clock). */
  limitedUntil: string | null;
  lastHitAt: string | null;
  hitsToday: number;
}

/** In-process tracker. Logs once when the limit is hit and once when it clears. */
export class QuotaTracker {
  private until = 0;
  private scope: QuotaScope | null = null;
  private lastHit = 0;
  private hits = 0;
  private day = "";

  constructor(private readonly log: (line: string) => void = (l) => console.warn(l), private readonly realNow: () => number = Date.now) {}

  record(err: QuotaError): void {
    const now = this.realNow();
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.hits = 0; }
    this.hits++;
    this.lastHit = now;
    const wasLimited = now < this.until;
    const until =
      err.scope === "day" ? nextDailyReset(new Date(now)).getTime() : now + (err.retryAfterSeconds ?? 60) * 1000;
    if (until > this.until) this.until = until;
    this.scope = err.scope === "day" || this.scope !== "day" || !wasLimited ? err.scope : this.scope;
    if (!wasLimited) {
      const when = new Date(this.until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      this.log(
        err.scope === "day"
          ? `[agents] Gemini DAILY limit used up. Characters send grounded templates until it resets around ${when}.`
          : `[agents] Gemini rate limit hit (${err.scope === "minute" ? "per-minute" : "unknown limit"}). Templates until about ${when}.`,
      );
    }
  }

  /** Call after a successful Gemini reply. */
  ok(): void {
    if (this.until && this.realNow() >= this.until - 1000) {
      this.log("[agents] Gemini is answering again.");
      this.until = 0;
      this.scope = null;
    }
  }

  /** True while we know Gemini will refuse, so callers can skip straight to the template and save time. */
  limited(): boolean {
    return this.realNow() < this.until;
  }

  status(): QuotaStatus {
    const limited = this.limited();
    return {
      ok: !limited,
      scope: limited ? this.scope : null,
      limitedUntil: limited ? new Date(this.until).toISOString() : null,
      lastHitAt: this.lastHit ? new Date(this.lastHit).toISOString() : null,
      hitsToday: this.hits,
    };
  }
}

/** One shared tracker for the running service. */
export const geminiQuota = new QuotaTracker();
