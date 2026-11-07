import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySimStateStore, SimClock, isQuietHours, jumpDays, localDate, localHour } from "../src";

const TZ = "America/Chicago";
const at = (iso: string) => new Date(iso);

test("now() is real time plus the offset", async () => {
  const store = new MemorySimStateStore({ offsetSeconds: 3 * 86400, demoMode: false, updatedAt: "2026-11-07T16:00:00.000Z" });
  const clock = new SimClock(store, () => at("2026-11-07T16:00:00.000Z").getTime());
  await clock.refresh();
  assert.equal(clock.now().toISOString(), "2026-11-10T16:00:00.000Z");
});

test("simulated time keeps ticking after a jump", async () => {
  let real = at("2026-11-07T16:00:00.000Z").getTime();
  const store = new MemorySimStateStore();
  const clock = new SimClock(store, () => real);
  await jumpDays(store, 2, real);
  await clock.refresh();
  real += 90_000;
  assert.equal(clock.now().toISOString(), "2026-11-09T16:01:30.000Z");
});

test("jumpDays accumulates and reset by writing zero", async () => {
  const store = new MemorySimStateStore();
  await jumpDays(store, 1);
  const s = await jumpDays(store, 2);
  assert.equal(s.offsetSeconds, 3 * 86400);
  await store.write({ ...s, offsetSeconds: 0 });
  assert.equal((await store.read()).offsetSeconds, 0);
});

test("local date and hour use the customer's timezone", () => {
  // 02:30 UTC on Nov 8 is still the evening of Nov 7 in Dallas (UTC-6)
  assert.equal(localDate(at("2026-11-08T02:30:00.000Z"), TZ), "2026-11-07");
  assert.equal(localHour(at("2026-11-08T02:30:00.000Z"), TZ), 20);
  assert.equal(localHour(at("2026-11-07T06:00:00.000Z"), TZ), 0);
});

test("quiet hours wrap past midnight, and demo mode or emergencies bypass them", () => {
  const night = at("2026-11-08T05:00:00.000Z"); // 23:00 Dallas
  const morning = at("2026-11-08T16:00:00.000Z"); // 10:00 Dallas
  const early = at("2026-11-08T13:00:00.000Z"); // 07:00 Dallas
  assert.equal(isQuietHours(night, TZ, { demoMode: false }), true);
  assert.equal(isQuietHours(early, TZ, { demoMode: false }), true);
  assert.equal(isQuietHours(morning, TZ, { demoMode: false }), false);
  assert.equal(isQuietHours(night, TZ, { demoMode: true }), false);
  assert.equal(isQuietHours(night, TZ, { demoMode: false, emergency: true }), false);
});
