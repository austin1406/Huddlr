import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { loadChat, loadOutboxStats, loadProposals, maskPhone, type Db } from "../src/state.js";

const PHONE = "+15550001111";

async function db(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../contracts/p2_agents.sql", import.meta.url), "utf8"));
  return pg as unknown as Db;
}

test("chat mirror interleaves the user's texts and the cast's replies in order", async () => {
  const d = await db();
  await d.query(`INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at, received_at) VALUES ('m1',$1,'can I afford dinner?', now(), now() - interval '10 seconds')`, [PHONE]);
  await d.query(`INSERT INTO outbox (idempotency_key, user_phone, speaker, text, status, created_sim_at, created_at) VALUES ('k1',$1,'checking','You have $438 until payday.','sent', now(), now() - interval '5 seconds')`, [PHONE]);
  await d.query(`INSERT INTO inbound_messages (provider_msg_id, user_phone, attachment_ids, received_sim_at, received_at) VALUES ('m2',$1,'{pho_att_x}', now(), now())`, [PHONE]);
  await d.query(`INSERT INTO outbox (idempotency_key, user_phone, speaker, text, created_sim_at) VALUES ('other','+19999999999','card','not for this user', now())`);
  const chat = await loadChat(d, PHONE);
  assert.deepEqual(chat.map((c) => [c.from, c.text, c.status ?? null, !!c.photo]), [
    ["user", "can I afford dinner?", null, false],
    ["checking", "You have $438 until payday.", "sent", false],
    ["user", "", null, true],
  ]);
});

test("queue stats and proposals", async () => {
  const d = await db();
  await d.query(`INSERT INTO outbox (idempotency_key, user_phone, speaker, text, status, created_sim_at) VALUES ('a',$1,'coach','x','sent', now()), ('b',$1,'coach','y','held', now())`, [PHONE]);
  assert.deepEqual(await loadOutboxStats(d), { pending: 0, sending: 0, sent: 1, held: 1, failed: 0 });
  await d.query(
    `INSERT INTO proposals (user_phone, plan, from_account, to_account, amount_cents, action_text, created_sim_at, expires_at)
     VALUES ($1, '{}', 'savings', 'checking', 14300, 'Move $143 from Savings to Checking', now(), now() + interval '2 hours')`,
    [PHONE],
  );
  const [p] = await loadProposals(d, PHONE);
  assert.equal(p.amount, 143);
  assert.equal(p.status, "pending");
});

test("phones are masked for the projector", () => {
  assert.equal(maskPhone("+19453365104"), "•••-5104");
});

test("loans told by text are read for the Huddle and the team dashboard", async () => {
  const { loadReportedLoans } = await import("../src/state.js");
  const d = await db();
  await d.query(
    `INSERT INTO memory_facts (user_phone, kind, key, value, source, created_sim_at, updated_sim_at) VALUES ($1, 'note', 'loan:tuition', $2, 'text', now(), now())`,
    [PHONE, JSON.stringify({ label: "tuition", owed: 10000, aprPercent: 5 })],
  );
  assert.deepEqual(await loadReportedLoans(d, PHONE), [{ label: "tuition", owed: 10000, aprPercent: 5 }]);
  assert.deepEqual(await loadReportedLoans(d, "+19999999999"), []);
});
