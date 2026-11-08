import { estimateLevel, makeDaySampler, mulberry32, priorFromPersona, type Prior, type Rng, type SpendModel, type SpendParams, SPEND_PARAMS } from "./spending";
import type { Persona } from "../../../contracts/src";

/**
 * Rolling-origin backtest for the spending level. At each origin the method sees only the days before it, predicts the
 * next `horizon` days, and is scored against what happened. Used to choose SPEND_PARAMS and to prove the learned model
 * is better than a flat average when habits change, and not meaningfully worse when they do not.
 */

export type LevelMethod = (history: number[]) => number;

export interface Score {
  /** Mean absolute error of the predicted total over the horizon, in dollars. */
  mae: number;
  /** Mean signed error (prediction minus actual): positive means it over-predicts spending. */
  bias: number;
}

export function rollingScore(series: number[], method: LevelMethod, horizon = 14, firstOrigin = 28, step = 7): Score {
  let abs = 0,
    signed = 0,
    n = 0;
  for (let t = firstOrigin; t + horizon <= series.length; t += step) {
    const predicted = method(series.slice(0, t)) * horizon;
    const actual = series.slice(t, t + horizon).reduce((s, v) => s + v, 0);
    abs += Math.abs(predicted - actual);
    signed += predicted - actual;
    n++;
  }
  return { mae: abs / Math.max(1, n), bias: signed / Math.max(1, n) };
}

export const flatMethod = (priorMean: number): LevelMethod => () => priorMean;
export const meanMethod: LevelMethod = (h) => h.reduce((s, v) => s + v, 0) / h.length;
export const learnedMethod =
  (prior: { mean: number; sd: number }, p: SpendParams = SPEND_PARAMS): LevelMethod =>
  (h) =>
    estimateLevel(h, prior, p).mean;

/** Ways spending can behave, each a multiplier on the profile's level for day i of n. */
export const SCENARIOS: Record<string, (i: number, n: number) => number> = {
  steady: () => 1,
  jump: (i, n) => (i < n * 0.5 ? 1 : 1.8),
  drift: (i, n) => 1 + (0.5 * i) / n,
  drop: (i, n) => (i < n * 0.5 ? 1 : 0.6),
};

export function generateSeries(prior: Prior, rng: Rng, days: number, level: (i: number, n: number) => number): number[] {
  return Array.from({ length: days }, (_, i) => prior.draw(rng) * level(i, days));
}

/** Average score of a method over many random histories for one scenario. */
export function scoreScenario(persona: Persona, scenario: string, method: LevelMethod, seeds = 40, days = 90): Score {
  const prior = priorFromPersona(persona);
  let mae = 0,
    bias = 0;
  for (let s = 0; s < seeds; s++) {
    const series = generateSeries(prior, mulberry32(1000 + s), days, SCENARIOS[scenario]!);
    const r = rollingScore(series, method);
    mae += r.mae;
    bias += r.bias;
  }
  return { mae: mae / seeds, bias: bias / seeds };
}

/**
 * How often the real 80% range (from the model's own sampler) contains what happened over the next 14 days.
 * A well-calibrated range covers about 80%.
 */
export function rangeCoverage(persona: Persona, scenario: string, seeds = 25, days = 90, horizon = 14, draws = 200): number {
  const prior = priorFromPersona(persona);
  let hit = 0,
    total = 0;
  for (let s = 0; s < seeds; s++) {
    const series = generateSeries(prior, mulberry32(5000 + s), days, SCENARIOS[scenario]!);
    for (let t = 35; t + horizon <= days; t += 14) {
      const seen = series.slice(0, t);
      const level = estimateLevel(seen, prior);
      const model: SpendModel = { level, values: seen, dates: seen.map((_, i) => `d${i}`), recurring: [], prior, basis: "history" };
      const rng = mulberry32(900 + s * 31 + t);
      const sums: number[] = [];
      for (let d = 0; d < draws; d++) {
        const sampler = makeDaySampler({ ...model, dates: seen.map((_, i) => dateOf(i)) }, rng, { driftPerMonth: 0 });
        let sum = 0;
        for (let k = 0; k < horizon; k++) sum += sampler(dateOf(t + k));
        sums.push(sum);
      }
      sums.sort((a, b) => a - b);
      const actual = series.slice(t, t + horizon).reduce((a, v) => a + v, 0);
      if (actual >= sums[Math.floor(draws * 0.1)]! && actual <= sums[Math.floor(draws * 0.9)]!) hit++;
      total++;
    }
  }
  return hit / total;
}

const dateOf = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10);
