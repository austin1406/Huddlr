// Prints real-Gemini debates for a few scenarios, for judging tone and content by eye.
//   npx tsx scripts/sample-debates.ts            (needs GEMINI_API_KEY in ../.env; ~10 Gemini calls)
import { PGlite } from "@electric-sql/pglite";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import type { FinanceEvent } from "../../contracts/src";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { cast } from "../src/character";
import { migrate } from "../src/db";
import { runEvent } from "../src/debate";
import { financeClient } from "../src/finance";
import { makeProposalService } from "../src/proposals";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const scenarios: Array<{ name: string; scenario: "normal" | "shortfall"; event: Omit<FinanceEvent, "occurredAt"> }> = [
  { name: "Rent-week shortfall", scenario: "shortfall", event: { id: "s1", type: "forecast_problem", severity: "high", accountId: "checking", data: {} } },
  { name: "Big Target purchase on the card", scenario: "normal", event: { id: "s2", type: "big_purchase", severity: "medium", accountId: "card", data: { merchant: "Target", amount: 142.37 } } },
  { name: "Paycheck landed", scenario: "normal", event: { id: "s3", type: "paycheck_landed", severity: "medium", accountId: "checking", data: { amount: 1650 } } },
];

for (const s of scenarios) {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState(s.scenario) });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  const facts = await finance.facts();
  const now = new Date(facts.asOf);
  const r = await runEvent(
    { db, finance, proposals: makeProposalService(db, () => now), userPhone: "+15555550100", clock: async () => ({ now, demoMode: true }) },
    { ...s.event, occurredAt: facts.asOf },
  );
  console.log(`\n=== ${s.name}  (first ${r.firstMessageMs} ms, plan ${r.planMs} ms)`);
  const rows = (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id")).rows;
  for (const m of rows) {
    const c = cast.find((x) => x.id === m.speaker)!;
    const src = r.messages.find((x) => x.speaker === m.speaker)?.source;
    console.log(`${c.emoji} ${c.name}: ${m.text}${src && src !== "model" ? `   [${src}]` : ""}`);
  }
  await new Promise((res) => setTimeout(res, 5000)); // stay under the free tier's per-minute limit
}
