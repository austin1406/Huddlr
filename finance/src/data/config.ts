import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Persona } from "../../../contracts/src";

const dir = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(dir + name, "utf8"));

export const Thresholds = z.object({
  version: z.literal(1),
  cushion: z.number(),
  bigPurchaseMin: z.number(),
  billDueSoonDays: z.number().int(),
  forecastProblemWithinDays: z.number().int(),
  shortfallEscalationHours: z.number(),
  highInterestAprPercent: z.number(),
  emergencyFundMonths: z.tuple([z.number(), z.number()]),
  indicators: z.record(
    z.string(),
    z.object({
      unit: z.enum(["months", "percent", "count"]),
      direction: z.enum(["higher_is_better", "lower_is_better"]),
      goodAt: z.number(),
      concernAt: z.number(),
    }),
  ),
});
export type Thresholds = z.infer<typeof Thresholds>;

/** The demo customer and the engine's thresholds, validated on load (same files the seed script and fixtures use). */
export const PERSONA: Persona = Persona.parse(load("persona.json"));
export const THRESHOLDS: Thresholds = Thresholds.parse(load("thresholds.json"));

/** A friend who owes this much or more counts as a p2p imbalance. Not in thresholds.json yet. */
export const P2P_IMBALANCE_MIN = 50;
