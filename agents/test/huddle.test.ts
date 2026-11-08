// The Huddle link: in the welcome text, and on request ("huddle link") at any time, even while a plan waits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/db";
import { HUDDLE_LINK_FAILED, huddleLinkText, isHuddleLinkRequest, replyWithHuddleLink } from "../src/huddle";
import { makeProposalService } from "../src/proposals";
import { handleInbound } from "../src/replies";
import { maybeWelcome, welcomeText } from "../src/welcome";

const PHONE = "+12145550123";
const URL1 = "https://example.test/me/abc.def";

test("link requests are recognized; money questions are not", () => {
  for (const t of ["huddle link", "Huddle link?", "send me my huddle", "can you resend the huddle link", "where's my huddle page", "huddle", "give me a new link", "send the link", "open the huddle table"])
    assert.equal(isHuddleLinkRequest(t), true, t);
  for (const t of ["how am I doing?", "send $200 to savings", "can I afford a $40 dinner", "yes", "link my bank", "new card?", "@Savings what's my runway", ""])
    assert.equal(isHuddleLinkRequest(t), false, t);
});

test("phone testing: everyday ways to ask for the link work too", () => {
  for (const t of ["can i get the link", "can I have the link?", "where is the link", "wheres my link", "link", "the link?", "can u send me the link", "can i see the dashboard", "dashboard link"])
    assert.equal(isHuddleLinkRequest(t), true, t);
  for (const t of ["link my bank account", "can i link my card", "where is my money going", "can i get a loan"]) assert.equal(isHuddleLinkRequest(t), false, t);
});

async function setup() {
  const db = new PGlite();
  await migrate(db);
  const now = new Date("2026-12-02T15:00:00.000Z");
  const text = async (id: number, body: string) => {
    await db.query(
      `INSERT INTO inbound_messages (id, provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, `m${id}`, PHONE, body, now],
    );
    return { id, user_phone: PHONE, text: body };
  };
  const outbox = async () => (await db.query<{ speaker: string; text: string }>(`SELECT speaker, text FROM outbox ORDER BY id`)).rows;
  return { db, now, text, outbox, proposals: makeProposalService(db, () => now) };
}

test("the welcome carries a link, and asks for one only once", async () => {
  const { db, now, text, outbox } = await setup();
  let minted = 0;
  const link = async () => (minted++, URL1);
  await text(1, "hi");
  assert.equal(await maybeWelcome(db, { id: 1, user_phone: PHONE }, now, link), true);
  assert.equal(await maybeWelcome(db, { id: 1, user_phone: PHONE }, now, link), false);
  assert.equal(minted, 1);
  const [w] = await outbox();
  assert.equal(w.text, welcomeText(URL1));
  assert.match(w.text, /See everyone at one table here: https:\/\/example\.test\/me\/abc\.def Text "huddle link" anytime/);
});

test("without the dashboard, the welcome is the plain intro", async () => {
  const { db, now, text, outbox } = await setup();
  await text(1, "hi");
  await maybeWelcome(db, { id: 1, user_phone: PHONE }, now, async () => null);
  assert.equal((await outbox())[0].text, welcomeText());
});

test("'huddle link' gets one fresh link, never handled as chat", async () => {
  const { db, now, text, outbox, proposals } = await setup();
  const row = await text(5, "send my huddle link");
  assert.deepEqual(await handleInbound(db, proposals, row, now), { kind: "huddle_link" });
  assert.equal(await replyWithHuddleLink(db, async () => URL1, row, now), "sent");
  assert.equal(await replyWithHuddleLink(db, async () => URL1, row, now), "sent"); // retried: still one message
  const msgs = await outbox();
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], { speaker: "coach", text: huddleLinkText(URL1) });
});

test("if the link can't be made, the user is told instead of left waiting", async () => {
  const { db, now, text, outbox } = await setup();
  const row = await text(7, "huddle link");
  assert.equal(await replyWithHuddleLink(db, async () => null, row, now), "failed");
  assert.equal((await outbox())[0].text, HUDDLE_LINK_FAILED);
});
