// One real-Gemini run of "I got a $600 bonus, what should I do?" against P1's stub. Prints the chat.
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { cast } from "../src/character";
import { migrate } from "../src/db";
import { runWindfall } from "../src/debate";
import { financeClient } from "../src/finance";
import { makeProposalService } from "../src/proposals";

const db = new PGlite();
await migrate(db);
const app = createApp({ secret: "", state: new StubState("normal") });
const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
const now = new Date((await finance.facts()).asOf);
const text = process.argv[2] ?? "I got a $600 bonus, what should I do?";
await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('x', '+15555550100', $1, $2)", [text, now]);
const t = Date.now();
await runWindfall({ db, finance, proposals: makeProposalService(db, () => now), userPhone: "+15555550100" }, { inboundId: 1, text, amount: 600, label: "the user got a bonus" }, now);
console.log(`   you: ${text}`);
for (const m of (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id")).rows) {
  const c = cast.find((x) => x.id === m.speaker)!;
  console.log(`${c.emoji} ${c.name}: ${m.text}`);
}
console.log(`(${Date.now() - t} ms)`);
