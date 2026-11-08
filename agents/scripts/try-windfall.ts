// Real-Gemini replay of a bonus conversation against P1's stub, follow-ups included. Prints the chat.
//   npx tsx scripts/try-windfall.ts                 short before payday (the phone test)
//   npx tsx scripts/try-windfall.ts normal          no shortfall
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { handleChat } from "../src/chat";
import { cast } from "../src/character";
import { migrate } from "../src/db";
import { runWindfall } from "../src/debate";
import { financeClient } from "../src/finance";
import { makeProposalService } from "../src/proposals";

const scenario = process.argv[2] === "normal" ? "normal" : "shortfall";
const PHONE = "+15555550100";
const db = new PGlite();
await migrate(db);
const app = createApp({ secret: "", state: new StubState(scenario) });
const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
const now = new Date((await finance.facts()).asOf);
const proposals = makeProposalService(db, () => now);

const texts = [
  "I got a $600 bonus. What should I do with it?",
  "why am i moving 152 from savings to checking? what about the 600?",
  "what was my saving before the bonus",
  "so where do i put the 600 bonus??",
];
let shown = 0;
for (const [i, text] of texts.entries()) {
  const id = Number((await db.query<{ id: number }>(
    "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id", [`t${i}`, PHONE, text, now],
  )).rows[0].id);
  await db.query("INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at) VALUES ($1, 'text', 'in', 'user', $2, $3, $4)", [PHONE, text, id, now]);
  const t = Date.now();
  await handleChat(
    { db, facts: () => finance.facts(), userPhone: PHONE, finance, windfall: (ask, at) => runWindfall({ db, finance, proposals, userPhone: PHONE }, ask, at) },
    { id, text },
    now,
  );
  console.log(`\n   you: ${text}`);
  const rows = (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id")).rows;
  for (const m of rows.slice(shown)) {
    const c = cast.find((x) => x.id === m.speaker)!;
    console.log(`${c.emoji} ${c.name}: ${m.text}`);
  }
  shown = rows.length;
  console.log(`   (${Date.now() - t} ms)`);
}
