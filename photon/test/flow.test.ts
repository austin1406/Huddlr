import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Db } from "../src/db.js";
import { saveInbound } from "../src/inbound.js";
import { sendOne, MAX_ATTEMPTS, type Transport } from "../src/sender.js";
import { formatMessage } from "../src/format.js";
import type { InboundMessage } from "../src/message.js";

const PHONE = "+15550001111";
const noWait = { wait: async () => {} };

async function freshDb(): Promise<Db> {
  const db = new PGlite() as unknown as Db;
  await migrate(db);
  return db;
}

function inbound(id: string, text = "hi"): InboundMessage {
  return {
    id,
    status: "received",
    sentBy: { id: "usr_human", kind: "human", handle: PHONE },
    receivedBy: { id: "usr_agent", kind: "agent", handle: "+16285550000" },
    space: { id: "space_1", kind: "direct" },
    content: { type: "text", text },
  };
}

async function queue(db: Db, key: string, speaker = "card", text = "hello", priority = 0) {
  await db.query(
    `INSERT INTO outbox (idempotency_key, user_phone, speaker, text, priority, created_sim_at) VALUES ($1,$2,$3,$4,$5, now())`,
    [key, PHONE, speaker, text, priority],
  );
}

function fakeTransport(failTimes = 0) {
  const sent: { text: string; key: string; parent?: string; spaceId: string; senderId: string }[] = [];
  let fails = failTimes;
  const t: Transport = {
    async sendText(target, text, key, parent) {
      if (fails-- > 0) throw new Error("photon down");
      sent.push({ text, key, parent, ...target });
      return { id: `pho_msg_${sent.length}` };
    },
    async setTyping() {
      return true;
    },
  };
  return { t, sent };
}

test("formats cast members with emoji and name", () => {
  assert.equal(formatMessage("card", "COP IT"), "💳 Card: COP IT");
  assert.equal(formatMessage("coach", "Plan below."), "🧭 Coach: Plan below.");
  assert.equal(formatMessage("system", "Proposal expired."), "Proposal expired.");
});

test("inbound is saved once, even if Photon delivers it twice", async () => {
  const db = await freshDb();
  assert.ok(await saveInbound(db, inbound("pho_msg_a", "ping")));
  assert.equal(await saveInbound(db, inbound("pho_msg_a", "ping")), null);
  const rows = (await db.query(`SELECT user_phone, text FROM inbound_messages`)).rows;
  assert.deepEqual(rows, [{ user_phone: PHONE, text: "ping" }]);
});

test("messages are held until the user texts, then sent to their conversation", async () => {
  const db = await freshDb();
  const { t, sent } = fakeTransport();
  await queue(db, "k1");
  assert.equal(await sendOne(db, t, noWait), "held");
  assert.equal(sent.length, 0);

  await saveInbound(db, inbound("pho_msg_b")); // user texts → held rows released
  assert.equal(await sendOne(db, t, noWait), "sent");
  assert.equal(sent[0].text, "💳 Card: hello");
  assert.equal(sent[0].spaceId, "space_1");
  assert.equal(sent[0].senderId, "usr_agent");
  assert.equal(sent[0].key, "outbox:k1");
  const row = (await db.query(`SELECT status, attempts FROM outbox`)).rows[0];
  assert.deepEqual(row, { status: "sent", attempts: 1 });
});

test("higher priority goes first, then oldest; replies thread under the user's message", async () => {
  const db = await freshDb();
  const { t, sent } = fakeTransport();
  const inboundId = await saveInbound(db, inbound("pho_msg_c"));
  await queue(db, "low", "savings", "proactive", 0);
  await db.query(
    `INSERT INTO outbox (idempotency_key, user_phone, speaker, text, priority, reply_to, created_sim_at) VALUES ('reply',$1,'coach','answer',1,$2, now())`,
    [PHONE, inboundId],
  );
  await sendOne(db, t, noWait);
  await sendOne(db, t, noWait);
  assert.deepEqual(sent.map((s) => s.text), ["🧭 Coach: answer", "🐷 Savings: proactive"]);
  assert.equal(sent[0].parent, "pho_msg_c");
});

test("retries, then gives up after 3 attempts", async () => {
  const db = await freshDb();
  await saveInbound(db, inbound("pho_msg_d"));
  await queue(db, "k2");

  const flaky = fakeTransport(1);
  assert.equal(await sendOne(db, flaky.t, noWait), "retry");
  assert.equal(await sendOne(db, flaky.t, noWait), "sent");

  await queue(db, "k3");
  const dead = fakeTransport(99);
  const results = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) results.push(await sendOne(db, dead.t, noWait));
  assert.deepEqual(results, ["retry", "retry", "failed"]);
  const row = (await db.query(`SELECT status, attempts, last_error FROM outbox WHERE idempotency_key = 'k3'`)).rows[0];
  assert.deepEqual(row, { status: "failed", attempts: 3, last_error: "photon down" });
});
