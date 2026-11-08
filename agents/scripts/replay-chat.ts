// Replay any texting conversation through the real chat path (real Gemini, P1's stub). Prints the chat.
//   npx tsx scripts/replay-chat.ts [normal|shortfall] "text 1" "text 2" ...
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { handleChat } from "../src/chat";
import { cast } from "../src/character";
import { migrate } from "../src/db";
import { runOptions, runRoundtable, runWindfall } from "../src/debate";
import { financeClient } from "../src/finance";
import { makeProposalService } from "../src/proposals";

const args = process.argv.slice(2);
const scenario = args[0] === "shortfall" ? "shortfall" : "normal";
const texts = args[0] === "normal" || args[0] === "shortfall" ? args.slice(1) : args;
const PHONE = "+15555550100";
const db = new PGlite();
await migrate(db);
const app = createApp({ secret: "", state: new StubState(scenario) });
const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
const now = new Date((await finance.facts()).asOf);
const proposals = makeProposalService(db, () => now);

let shown = 0;
for (const [i, text] of texts.entries()) {
  const id = Number((await db.query<{ id: number }>(
    "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id", [`t${i}`, PHONE, text, now],
  )).rows[0].id);
  // What handleInbound does first: the user's text joins the shared history.
  await db.query("INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at) VALUES ($1, 'text', 'in', 'user', $2, $3, $4)", [PHONE, text, id, now]);
  const t = Date.now();
  await handleChat(
    { db, facts: () => finance.facts(), userPhone: PHONE, finance, proposals,
      windfall: (ask, at) => runWindfall({ db, finance, proposals, userPhone: PHONE }, ask, at),
      options: (ask, at) => runOptions({ db, finance, proposals, userPhone: PHONE }, ask, at),
      roundtable: (ask, at) => runRoundtable({ db, finance, proposals, userPhone: PHONE }, ask, at) },
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
