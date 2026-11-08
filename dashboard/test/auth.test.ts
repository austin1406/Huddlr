import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { cancelOlderLinks, checkCode, codeMessage, endSession, linksValidFrom, migrateAuth, newCode, newSession, queueCode, sessionPhone } from "../src/auth.js";
import { hideCodes, type Db } from "../src/state.js";

const PHONE = "+15550001111";
const S = "s3cret";
async function db(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../contracts/p2_agents.sql", import.meta.url), "utf8"));
  await migrateAuth(pg as unknown as Db);
  return pg as unknown as Db;
}

test("the right code works once; wrong codes run out after five tries", async () => {
  const d = await db();
  const r = await newCode(d, S, PHONE, 1_000_000);
  assert.ok(r.ok);
  const code = (r as { code: string }).code;
  assert.match(code, /^\d{6}$/);
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal(await checkCode(d, S, PHONE, wrong, 1_000_100), "wrong");
  assert.equal(await checkCode(d, S, PHONE, code, 1_000_200), "ok");
  assert.equal(await checkCode(d, S, PHONE, code, 1_000_300), "none"); // single use

  const r2 = await newCode(d, S, PHONE, 1_100_000);
  const c2 = (r2 as { code: string }).code;
  const bad = c2 === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) assert.equal(await checkCode(d, S, PHONE, bad, 1_100_100), "wrong");
  assert.equal(await checkCode(d, S, PHONE, bad, 1_100_100), "too_many");
  assert.equal(await checkCode(d, S, PHONE, c2, 1_100_100), "too_many"); // even the right one, now
});

test("codes expire after 10 minutes and can't be re-sent too fast", async () => {
  const d = await db();
  const r = (await newCode(d, S, PHONE, 0)) as { code: string };
  assert.equal(await checkCode(d, S, PHONE, r.code, 10 * 60_000 + 1), "expired");
  const again = await newCode(d, S, PHONE, 10_000);
  assert.deepEqual(again, { ok: false, reason: "wait", retryInSeconds: 20 });
});

test("at most five codes an hour", async () => {
  const d = await db();
  for (let i = 0; i < 5; i++) assert.ok((await newCode(d, S, PHONE, i * 31_000)).ok);
  const sixth = await newCode(d, S, PHONE, 5 * 31_000);
  assert.equal(sixth.ok, false);
  assert.ok((await newCode(d, S, PHONE, 3600_000 + 1)).ok);
});

test("sessions belong to one phone and end on lock or after 24 hours", async () => {
  const d = await db();
  const t = await newSession(d, S, PHONE, 0);
  assert.equal(await sessionPhone(d, S, t, 1000), PHONE);
  assert.equal(await sessionPhone(d, S, t, 24 * 3600_000 + 1), null);
  assert.equal(await sessionPhone(d, S, "made-up", 1000), null);
  await endSession(d, S, t);
  assert.equal(await sessionPhone(d, S, t, 1000), null);
});

test("a new link cancels older ones", async () => {
  const d = await db();
  assert.equal(await linksValidFrom(d, PHONE), 0);
  await cancelOlderLinks(d, PHONE, 5_000_000);
  assert.equal(await linksValidFrom(d, PHONE), 5000);
});

test("the code is texted ahead of everything else and hidden on the projector", async () => {
  const d = await db();
  await queueCode(d, PHONE, "482913", 1);
  const r = await d.query<{ speaker: string; priority: number; text: string }>(`SELECT speaker, priority, text FROM outbox`);
  assert.equal(r.rows[0].speaker, "system");
  assert.equal(Number(r.rows[0].priority), 2);
  assert.equal(r.rows[0].text, codeMessage("482913"));
  assert.equal(hideCodes(r.rows[0].text), "Your Huddle code is ••••••. It expires in 10 minutes. Never share it with anyone.");
});
