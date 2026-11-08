// Real-Gemini check of the photo flow: npx tsx scripts/try-photo.ts test/fixtures/price-tag.png
import { PGlite } from "@electric-sql/pglite";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { migrate } from "../src/db";
import { financeClient } from "../src/finance";
import { fileImageFetcher, geminiReader, handlePhoto } from "../src/photo";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
for (const path of process.argv.slice(2)) {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, attachment_ids, received_sim_at) VALUES ('p', '+15555550100', $1, now())", [[path]]);
  const t = Date.now();
  const read = geminiReader(process.env.GEMINI_API_KEY!);
  console.log(`\n${path}: Gemini read`, JSON.stringify(await read((await fileImageFetcher(path))!)));
  const r = await handlePhoto({ db, finance, userPhone: "+15555550100", fetchImage: fileImageFetcher, readPhoto: read }, { id: 1, user_phone: "+15555550100", attachment_ids: [path] }, new Date());
  const out = (await db.query<{ text: string }>("SELECT text FROM outbox")).rows.map((x) => x.text);
  console.log(`-> ${r.kind} in ${Date.now() - t} ms\n🏦 Checking: ${out.join(" | ")}`);
  await new Promise((res) => setTimeout(res, 4000));
}
