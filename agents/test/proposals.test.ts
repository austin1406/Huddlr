import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Plan } from "../../contracts/src";
import { migrate } from "../src/db";
import { makeProposalService } from "../src/proposals";

const plan = Plan.parse(JSON.parse(readFileSync(new URL("../../contracts/fixtures/plan.fixture.json", import.meta.url), "utf8")));
const PHONE = "+12145550123";
const HOUR = 3600_000;

/** Fresh database and a clock we can move by hand (simulated time). */
async function setup() {
  const db = new PGlite();
  await migrate(db);
  let t = new Date("2026-12-02T15:00:00.000Z").getTime();
  const svc = makeProposalService(db, () => new Date(t));
  const clock = { jump: (ms: number) => { t += ms; } };
  const create = (amount = 143) =>
    svc.create({ userPhone: PHONE, plan, from: "savings", to: "checking", amount, actionText: `Move $${amount} from Savings to Checking` });
  return { db, svc, clock, create };
}

test("create, then getPending returns it in P1's ProposalSummary shape (dollars, string id)", async () => {
  const { svc, create } = await setup();
  const r = await create();
  assert.equal(r.ok, true);
  const p = await svc.getPending(PHONE);
  assert.equal(p?.amount, 143);
  assert.equal(typeof p?.id, "string");
  assert.equal(p?.expiresAt, "2026-12-02T17:00:00.000Z");
});

test("accept once works; a duplicate YES is a harmless no-op", async () => {
  const { svc, create } = await setup();
  const id = Number((await create()).proposal!.id);
  const first = await svc.accept(id, "text");
  assert.deepEqual([first.ok, first.status], [true, "accepted"]);
  const again = await svc.accept(id, "voice");
  assert.deepEqual([again.ok, again.reason, again.status], [false, "already_accepted", "accepted"]);
  assert.equal(await svc.getPending(PHONE), null);
});

test("two YES at the same moment: exactly one wins", async () => {
  const { svc, create } = await setup();
  const id = Number((await create()).proposal!.id);
  const results = await Promise.all([svc.accept(id, "text"), svc.accept(id, "voice")]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("expires 2 hours later on simulated time; a late YES is refused", async () => {
  const { svc, clock, create } = await setup();
  const id = Number((await create()).proposal!.id);
  clock.jump(2 * HOUR - 1000);
  assert.ok(await svc.getPending(PHONE), "still pending just before 2h");
  clock.jump(1000);
  const late = await svc.accept(id, "text");
  assert.deepEqual([late.ok, late.reason, late.status], [false, "expired", "expired"]);
  assert.equal(await svc.getPending(PHONE), null);
});

test("a fast-forward (jump-days) expires pending proposals", async () => {
  const { svc, clock, create } = await setup();
  await create();
  clock.jump(2 * 24 * HOUR);
  assert.equal(await svc.getPending(PHONE), null);
});

test("decline, then accept is refused", async () => {
  const { svc, create } = await setup();
  const id = Number((await create()).proposal!.id);
  assert.equal((await svc.decline(id, "text")).status, "declined");
  const r = await svc.accept(id, "text");
  assert.deepEqual([r.ok, r.reason], [false, "not_pending"]);
});

test("one pending per user: a new plan replaces the old one", async () => {
  const { svc, create } = await setup();
  const old = Number((await create(143)).proposal!.id);
  await create(200);
  assert.equal((await svc.getPending(PHONE))?.amount, 200);
  assert.equal((await svc.get(old))?.status, "expired");
});

test("markCompleted: from accepted or straight from pending; repeats are harmless", async () => {
  const { svc, create } = await setup();
  const a = Number((await create()).proposal!.id);
  await svc.accept(a, "text");
  const done = await svc.markCompleted(a, "nessie-transfer-1");
  assert.equal(done.status, "completed");
  assert.equal((await svc.get(a))?.completed_txn_id, "nessie-transfer-1");
  assert.equal((await svc.markCompleted(a, "nessie-transfer-1")).reason, "already_completed");

  const b = Number((await create()).proposal!.id);
  assert.equal((await svc.markCompleted(b, "nessie-transfer-2")).status, "completed", "user moved money without texting YES");
});

test("unknown id and garbage ids are not_found", async () => {
  const { svc } = await setup();
  assert.equal((await svc.accept(999, "text")).reason, "not_found");
  assert.equal((await svc.accept(Number("abc"), "text")).reason, "not_found");
});

test("amounts are stored as integer cents", async () => {
  const { db, create } = await setup();
  await create(143.5);
  const r = await db.query<{ amount_cents: number }>("SELECT amount_cents FROM proposals");
  assert.equal(Number(r.rows[0].amount_cents), 14350);
});
