// Regenerates contracts/fixtures/projection.fixture.json from the engine. Run from finance/:  npx tsx scripts/gen-projection-fixture.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildProjectionFixture } from "../test/helpers/projectionFixture";

const file = fileURLToPath(new URL("../../contracts/fixtures/projection.fixture.json", import.meta.url));
writeFileSync(file, JSON.stringify(await buildProjectionFixture()) + "\n");
console.log(`wrote ${file}`);
