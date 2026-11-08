// contracts/fixtures/projection.fixture.json is what the dashboard shows in sample mode. It must equal what the engine
// produces for Maya on 2026-11-07, so a change to the projection rules fails here until the fixture is regenerated:
//   cd finance && npx tsx scripts/gen-projection-fixture.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildProjectionFixture, PRESETS } from "./helpers/projectionFixture";

const FILE = fileURLToPath(new URL("../../contracts/fixtures/projection.fixture.json", import.meta.url));

test("the projection fixture equals the engine's output for every preset", async () => {
  const expected = await buildProjectionFixture();
  const actual = JSON.parse(readFileSync(FILE, "utf8"));
  assert.deepEqual(Object.keys(actual), PRESETS.map((p) => p.key));
  assert.deepEqual(actual, expected);
});
