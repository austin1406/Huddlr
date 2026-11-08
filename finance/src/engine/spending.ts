import type { Persona } from "../../../contracts/src";
import { addDays, daysBetween, r2 } from "./calendar";
import type { LedgerState } from "./ledger";

/**
 * Everyday spending is the one part of the future that is genuinely uncertain, so it is the part that is learned.
 * Paychecks, bills and loan terms are known contracts and stay exact.
 *
 * What is learned, from what the ledger has actually seen:
 *  - the LEVEL of daily spending: a Bayesian blend of the profile's belief (a flat average, with a spread worked out
 *    from the profile's merchants) and recent history, weighted toward recent days. It moves only as far as the
 *    evidence justifies, so ordinary noise does not rewrite the forecast but a real change in habits does.
 *  - the SHAPE of spending: real days are resampled (weekday by weekday), so a bad day is as big, and as rare, as it is
 *    in your own history.
 *  - RECURRING payments that nobody told the engine about (a new subscription): found from their rhythm.
 */

/** Tuned by the backtest in test/backtest.test.ts; see docs/finance.md. */
export const SPEND_PARAMS = {
  /** Prior belief about the daily level may be off by this fraction (one standard deviation). */
  tauFrac: 0.2,
  /** Recent days count more: a day's weight halves every this many days. */
  halfLifeDays: 14,
  /** Days of history used. */
  windowDays: 90,
  /** Below this many observed days the profile's belief is used as is. */
  minDays: 7,
};
export type SpendParams = typeof SPEND_PARAMS;

// ---------------------------------------------------------------- randomness (seeded, so the same question gets the same answer)

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function poisson(rng: Rng, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0,
    p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

// ---------------------------------------------------------------- the profile's belief

export interface Prior {
  mean: number;
  sd: number;
  /** One random day drawn from the profile's merchants, scaled so the long-run mean is the profile's daily average. */
  draw(rng: Rng): number;
}

/** Each merchant is a compound Poisson process: visits at perWeek / 7 a day, each for a uniform amount in its range. */
export function priorFromPersona(persona: Persona): Prior {
  const ms = persona.seedHints.merchants;
  let mean = 0,
    variance = 0;
  for (const m of ms) {
    const lam = m.perWeek / 7,
      [lo, hi] = m.typicalAmount;
    mean += (lam * (lo + hi)) / 2;
    variance += (lam * (lo * lo + lo * hi + hi * hi)) / 3;
  }
  const anchor = persona.spending.averageDailyDiscretionary;
  const scale = mean > 0 ? anchor / mean : 1;
  return {
    mean: anchor,
    sd: Math.sqrt(variance) * scale,
    draw(rng) {
      let total = 0;
      for (const m of ms) {
        const visits = poisson(rng, m.perWeek / 7);
        for (let i = 0; i < visits; i++) total += m.typicalAmount[0] + rng() * (m.typicalAmount[1] - m.typicalAmount[0]);
      }
      return total * scale;
    },
  };
}

// ---------------------------------------------------------------- what the ledger has seen

export interface SpendItem {
  date: string;
  amount: number;
  description: string;
}

export interface SpendHistory {
  dates: string[];
  values: number[];
  /** Individual purchases, for finding recurring payments. */
  items: SpendItem[];
}

/**
 * One number per day, oldest first, ending yesterday: everything that left checking or the card as spending.
 * Before the ledger started that is the transaction log's history. Since then it is what the ledger booked: the
 * everyday background plus any purchase posted on top of it.
 */
export function buildHistory(state: LedgerState, today: string, windowDays: number): SpendHistory {
  const end = addDays(today, -1);
  const past = state.history ?? [];
  const sinceMs = addDays(today, -windowDays);
  const first = [state.createdDate, ...past.map((p) => p.date)].reduce((a, b) => (a < b ? a : b));
  const start = first < sinceMs ? sinceMs : first;
  if (start > end) return { dates: [], values: [], items: [] };
  const n = daysBetween(start, end) + 1;
  const values = new Array<number>(n).fill(0);
  const dates = Array.from({ length: n }, (_, i) => addDays(start, i));
  const items: SpendItem[] = [];
  const put = (date: string, amount: number, description: string) => {
    const i = daysBetween(start, date);
    if (i < 0 || i >= n) return;
    values[i]! += amount;
    items.push({ date, amount, description });
  };
  for (const p of past) put(p.date, p.amount, p.description);
  for (const t of state.txns) {
    if (t.kind === "daily") put(t.date, t.amount, "everyday spending");
    else if (t.kind === "purchase" || t.kind === "withdrawal") put(t.date, t.amount, t.merchant ?? t.label ?? "purchase");
  }
  // A purchase posted today is not a full day yet, but it is already evidence of a rhythm (and is already paid).
  for (const t of state.txns) if (t.kind === "purchase" && t.date === today) items.push({ date: today, amount: t.amount, description: t.merchant ?? "purchase" });
  return { dates, values: values.map((v) => r2(v)), items };
}

// ---------------------------------------------------------------- recurring payments nobody told us about

export interface Recurring {
  label: string;
  amount: number;
  /** 7 weekly, 14 every two weeks, 30 monthly. */
  everyDays: 7 | 14 | 30;
  nextDate: string;
  seen: number;
}

const PERIODS: { days: 7 | 14 | 30; lo: number; hi: number }[] = [
  { days: 7, lo: 6, hi: 8 },
  { days: 14, lo: 12, hi: 16 },
  { days: 30, lo: 27, hi: 34 },
];

/**
 * A payment is "recurring" when the same merchant is charged at least three times, the gaps between charges fit one
 * rhythm (weekly, every two weeks, monthly), the amounts are close, and the last charge is recent enough that it has
 * not stopped. Coffee shops and grocery runs fail the rhythm test, which is the point.
 */
export function detectRecurring(items: SpendItem[], today: string, skip: Set<string> = new Set()): Recurring[] {
  const groups = new Map<string, SpendItem[]>();
  for (const it of items) {
    const key = it.description.trim().toLowerCase();
    if (!key || key === "everyday spending" || skip.has(key)) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }
  const found: Recurring[] = [];
  for (const [, g] of groups) {
    if (g.length < 3) continue;
    const sorted = [...g].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = sorted.slice(1).map((s, i) => daysBetween(sorted[i]!.date, s.date)).filter((d) => d > 0);
    if (gaps.length < 2) continue;
    const amounts = sorted.map((s) => s.amount).sort((a, b) => a - b);
    const med = amounts[Math.floor(amounts.length / 2)]!;
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const cv = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length) / (mean || 1);
    if (cv > 0.1) continue;
    const period = PERIODS.find((p) => gaps.filter((d) => d >= p.lo && d <= p.hi).length / gaps.length >= 0.75);
    if (!period) continue;
    const last = sorted[sorted.length - 1]!;
    if (daysBetween(last.date, today) > period.days * 1.6) continue; // it stopped
    let next = period.days === 30 ? nextMonthly(last.date) : addDays(last.date, period.days);
    while (next < today) next = period.days === 30 ? nextMonthly(next) : addDays(next, period.days);
    found.push({ label: sorted[0]!.description, amount: r2(med), everyDays: period.days, nextDate: next, seen: sorted.length });
  }
  return found.sort((a, b) => b.amount - a.amount);
}

/** The same day next month (clamped to the month's length). */
export function nextMonthly(date: string): string {
  const y = Number(date.slice(0, 4)),
    m = Number(date.slice(5, 7)),
    d = Number(date.slice(8, 10));
  const ny = m === 12 ? y + 1 : y,
    nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- the learned level

export interface Level {
  mean: number;
  sd: number;
  /** The profile's belief, and how much of the answer came from data instead (0 to 1). */
  priorMean: number;
  weightOnData: number;
  daysObserved: number;
  /** Standard error of the level itself: how far the true daily level may be from this estimate. */
  se: number;
}

/** Normal-normal Bayes: the profile's belief against recent days, with recent days counting more. */
export function estimateLevel(values: number[], prior: { mean: number; sd: number }, p: SpendParams = SPEND_PARAMS): Level {
  const n = values.length;
  if (n < p.minDays) return { mean: prior.mean, sd: prior.sd, priorMean: prior.mean, weightOnData: 0, daysObserved: n, se: Math.max(1, p.tauFrac * prior.mean) };
  let sw = 0,
    sw2 = 0,
    sx = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(0.5, (n - 1 - i) / p.halfLifeDays);
    sw += w;
    sw2 += w * w;
    sx += w * values[i]!;
  }
  const xbar = sx / sw;
  const nEff = (sw * sw) / sw2;
  const m = values.reduce((s, v) => s + v, 0) / n;
  const s = Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, n - 1));
  const sigma = (n * s + 14 * prior.sd) / (n + 14); // few days of data: lean on the profile's spread
  const dataPrecision = nEff / (sigma * sigma);
  const tau = Math.max(1, p.tauFrac * prior.mean);
  const priorPrecision = 1 / (tau * tau);
  const w = dataPrecision / (dataPrecision + priorPrecision);
  return { mean: r2(w * xbar + (1 - w) * prior.mean), sd: r2(sigma), priorMean: prior.mean, weightOnData: r2(w), daysObserved: n, se: Math.sqrt(1 / (dataPrecision + priorPrecision)) };
}

export interface SpendModel {
  level: Level;
  /** Observed days with recurring payments taken out. */
  values: number[];
  dates: string[];
  recurring: Recurring[];
  prior: Prior;
  basis: "profile" | "history";
}

export function fitSpendModel(state: LedgerState, persona: Persona, today: string, p: SpendParams = SPEND_PARAMS): SpendModel {
  const prior = priorFromPersona(persona);
  const hist = buildHistory(state, today, p.windowDays);
  const skip = new Set(persona.recurringBills.map((b) => b.label.toLowerCase()));
  const recurring = detectRecurring(hist.items, today, skip);
  let values = hist.values;
  if (recurring.length) {
    const labels = new Set(recurring.map((r) => r.label.trim().toLowerCase()));
    values = hist.values.slice();
    for (const it of hist.items) {
      if (!labels.has(it.description.trim().toLowerCase())) continue;
      const i = daysBetween(hist.dates[0]!, it.date);
      if (i >= 0 && i < values.length) values[i] = Math.max(0, values[i]! - it.amount);
    }
  }
  const level = estimateLevel(values, prior, p);
  return { level, values, dates: hist.dates, recurring, prior, basis: level.daysObserved >= p.minDays ? "history" : "profile" };
}

/**
 * Draws one day of spending. With enough history it resamples real days (70% from the same weekday, 30% from any day
 * so a few days of data are not over-trusted), re-centered on the learned level. Without it, it draws from the profile.
 */
export interface SamplerOptions {
  /** This future gets its own true daily level, drawn around the estimate (the estimate is not exact). Default true. */
  levelUncertainty?: boolean;
  /** Habits wander: each month the level moves by a random step with this standard deviation (a fraction). Default 0.03. */
  driftPerMonth?: number;
}

function normal(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

export function makeDaySampler(model: SpendModel, rng: Rng, opts: SamplerOptions = {}): (date: string, weekday?: number) => number {
  const { values, dates, level, prior } = model;
  const drift = opts.driftPerMonth ?? 0.03;
  // one persistent factor for this future: how much higher or lower than estimated the true level turns out to be
  let factor = opts.levelUncertainty === false ? 1 : Math.exp((level.se / Math.max(1, level.mean)) * normal(rng));
  let month = "";
  const wander = (date: string) => {
    const m = date.slice(0, 7);
    if (month && m !== month && drift > 0) factor *= Math.exp(drift * normal(rng));
    month = m;
    return factor;
  };
  if (model.basis === "profile" || values.length < 21) {
    const shift = prior.mean > 0 ? level.mean / prior.mean : 1;
    return (date) => prior.draw(rng) * shift * wander(date);
  }
  const overall = values.reduce((s, v) => s + v, 0) / values.length || 1;
  const scale = level.mean / overall;
  const byWeekday: number[][] = [[], [], [], [], [], [], []];
  dates.forEach((d, i) => byWeekday[new Date(d + "T00:00:00Z").getUTCDay()]!.push(values[i]!));
  return (date, weekday) => {
    const pool = byWeekday[weekday ?? new Date(date + "T00:00:00Z").getUTCDay()]!;
    const from = pool.length >= 4 && rng() < 0.7 ? pool : values;
    return from[Math.floor(rng() * from.length)]! * scale * wander(date);
  };
}
