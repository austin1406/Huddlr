import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { FactsSnapshot } from "../../contracts/src";
import { handleChat, pickResponder } from "../src/chat";
import { migrate } from "../src/db";
import { extractMemory, loadMemory } from "../src/memory";

const facts = FactsSnapshot.parse(JSON.parse(readFileSync(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url), "utf8")));
const PHONE = "+12145550123";
const now = new Date("2026-11-07T18:00:00.000Z");

test("goals: with and without an amount and a date", () => {
  const a = extractMemory("I'm saving for a trip to Japan");
  assert.equal(a[0]?.key, "goal:trip_to_japan");
  const b = extractMemory("I want to save $2,000 for a car by May.");
  assert.deepEqual(b[0]?.value, { label: "car", target: 2000, by: "May" });
  assert.match(b[0]!.ack, /\$2,000/);
  const c = extractMemory("my goal is a new laptop $1200");
  assert.equal(c[0]?.kind, "goal");
});

test("preferences: quiet times and fewer messages", () => {
  assert.deepEqual(extractMemory("please don't text me after 9pm")[0]?.value, { hour: 21, minute: 0 });
  assert.equal(extractMemory("no messages before 10am")[0]?.key, "pref:quiet_end_hour");
  assert.equal(extractMemory("you guys text me less please")[0]?.key, "pref:fewer_messages");
});

test("ordinary questions are not memories", () => {
  for (const t of ["how is my card doing?", "can I afford a $40 dinner", "yes", "what's my balance"]) assert.deepEqual(extractMemory(t), [], t);
});

test("responder is picked by topic", () => {
  assert.equal(pickResponder("what's my credit card APR"), "card");
  assert.equal(pickResponder("can I afford dinner tonight?"), "checking");
  assert.equal(pickResponder("how's my retirement"), "ira");
  assert.equal(pickResponder("hello"), "coach");
});

test("a goal is saved, updated not duplicated, and acknowledged once", async () => {
  const db = new PGlite();
  await migrate(db);
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'x', now()), ('b', $1, 'x', now())", [PHONE]);
  const deps = { db, facts: async () => facts, userPhone: PHONE };
  assert.equal((await handleChat(deps, { id: 1, text: "saving for a car" }, now)).learned, 1);
  await handleChat(deps, { id: 2, text: "I want to save $3,000 for a car" }, now);
  const mem = await loadMemory(db, PHONE);
  assert.equal(mem.length, 1);
  assert.deepEqual(mem[0].value, { label: "car", target: 3000 });
  const out = await db.query<{ text: string }>("SELECT text FROM outbox ORDER BY id");
  assert.equal(out.rows.length, 2);
  assert.match(out.rows[1].text, /\$3,000/);
});

test("a question gets one grounded answer; the user's own number may be repeated", async () => {
  const db = new PGlite();
  await migrate(db);
  await db.query("INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ('a', $1, 'x', now())", [PHONE]);
  const r = await handleChat(
    { db, facts: async () => facts, userPhone: PHONE, model: async () => "A $40 dinner is fine; you have $437.50 safe to spend until payday." },
    { id: 1, text: "can I afford a $40 dinner tonight?" },
    now,
  );
  assert.equal(r.responder, "checking");
  const out = await db.query<{ speaker: string; text: string }>("SELECT speaker, text FROM outbox");
  assert.equal(out.rows[0].speaker, "checking");
  assert.match(out.rows[0].text, /\$40 dinner/, "model answer kept, not replaced by the template");
});
