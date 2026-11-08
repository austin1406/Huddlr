// Photo and text affordability, against P1's finance stub (can_i_afford) and an in-memory Postgres.
// Gemini's reading is faked here; scripts/try-photo.ts runs the real vision call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { checkMessage } from "../src/checker";
import { handleChat } from "../src/chat";
import { migrate } from "../src/db";
import { financeClient } from "../src/finance";
import { affordText, fileImageFetcher, handlePhoto, parseAffordQuestion, type PhotoReading } from "../src/photo";

const PHONE = "+15555550100";
const now = new Date("2026-11-07T16:00:00.000Z");

async function setup() {
  const db = new PGlite();
  await migrate(db);
  const app = createApp({ secret: "", state: new StubState("normal") });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => app.request(u.replace("http://f", ""), i)) as typeof fetch);
  let n = 0;
  const inbound = async (text: string | null, attachments: string[] = []) => {
    const r = await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, attachment_ids, received_sim_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [`m${++n}`, PHONE, text, attachments, now],
    );
    return Number(r.rows[0].id);
  };
  const outbox = async () => (await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox ORDER BY id")).rows;
  const facts = await finance.facts();
  return { db, finance, inbound, outbox, chat: (id: number, text: string) => handleChat({ db, facts: async () => facts, userPhone: PHONE, finance }, { id, text }, now) };
}

const reader = (r: PhotoReading) => async () => r;
const photo = "test/fixtures/price-tag.png";

test("parses 'can I afford' questions with one dollar amount", () => {
  assert.deepEqual(parseAffordQuestion("can I afford a $40 dinner tonight?"), { amount: 40, item: "dinner" });
  assert.deepEqual(parseAffordQuestion("Can I buy $79.99 headphones"), { amount: 79.99, item: "headphones" });
  assert.equal(parseAffordQuestion("how is my card"), null);
  assert.equal(parseAffordQuestion("can I afford $40 or $60?"), null, "two amounts is ambiguous");
});

test("a confident photo reading gets can_i_afford's verdict, numbers from the engine only", async () => {
  const { db, finance, inbound, outbox } = await setup();
  const id = await inbound(null, [photo]);
  const r = await handlePhoto({ db, finance, userPhone: PHONE, fetchImage: fileImageFetcher, readPhoto: reader({ item: "Wireless Headphones", price: 79.99, confident: true }) },
    { id, user_phone: PHONE, attachment_ids: [photo] }, now);
  assert.equal(r.kind, "answered");
  const [m] = await outbox();
  assert.equal(m.speaker, "checking");
  const afford = await finance.canIAfford(79.99);
  assert.equal(m.text, affordText(afford, "Wireless Headphones"));
  assert.equal(checkMessage(m.text, afford).ok, true);
});

test("an unsure reading asks to confirm, and the price reply gets the verdict", async () => {
  const { db, finance, inbound, outbox, chat } = await setup();
  const id = await inbound(null, [photo]);
  const r = await handlePhoto({ db, finance, userPhone: PHONE, fetchImage: fileImageFetcher, readPhoto: reader({ item: "Sneakers", price: 120, confident: false }) },
    { id, user_phone: PHONE, attachment_ids: [photo] }, now);
  assert.equal(r.kind, "confirm");
  assert.match((await outbox())[0].text, /Is that \$120\.00 for the sneakers\?/);
  const reply = await inbound("$110");
  assert.equal((await chat(reply, "$110")).responder, "checking");
  assert.match((await outbox())[1].text, /\$110\.00 for sneakers/);
});

test("no image service or no Gemini: an honest ask for the price, never silence", async () => {
  const { db, finance, inbound, outbox } = await setup();
  const id = await inbound(null, ["pho_att_123"]);
  const r = await handlePhoto({ db, finance, userPhone: PHONE, fetchImage: async () => null }, { id, user_phone: PHONE, attachment_ids: ["pho_att_123"] }, now);
  assert.equal(r.kind, "unavailable");
  assert.match((await outbox())[0].text, /Text me the item and price/);
  const again = await handlePhoto({ db, finance, userPhone: PHONE }, { id, user_phone: PHONE, attachment_ids: ["pho_att_123"] }, now);
  assert.equal(again.kind, "duplicate");
});

test("'can I afford a $40 dinner?' by text uses can_i_afford, not the model", async () => {
  const { inbound, outbox, chat, finance } = await setup();
  const id = await inbound("can I afford a $40 dinner tonight?");
  assert.equal((await chat(id, "can I afford a $40 dinner tonight?")).responder, "checking");
  assert.equal((await outbox())[0].text, affordText(await finance.canIAfford(40), "dinner"));
});
