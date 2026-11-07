import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FactsSnapshot, FinanceEvent, WhatIfResult } from "../../../contracts/src";

const dir = fileURLToPath(new URL("../../../contracts/fixtures/", import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(dir + name, "utf8"));

/** The contract fixtures, validated on load so a drifting fixture fails fast. */
export const FIXTURES = {
  normal: FactsSnapshot.parse(load("facts.fixture.json")),
  shortfall: FactsSnapshot.parse(load("facts.shortfall.fixture.json")),
  events: FinanceEvent.array().parse(load("events.fixture.json")),
  whatIf: WhatIfResult.parse(load("what_if.fixture.json")),
};
