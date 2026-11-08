import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadProjection, parseWindow, projectionFixture } from "../src/state.js";

test("a window is a whole number of days, weeks, months or years, up to 10 years", () => {
  assert.deepEqual(parseWindow({ amount: 6, unit: "months" }), { amount: 6, unit: "months", compare: true });
  assert.deepEqual(parseWindow({ amount: 90, unit: "days", compare: false }), { amount: 90, unit: "days", compare: false });
  assert.equal(parseWindow({ amount: 10, unit: "years" })?.amount, 10);
  for (const bad of [null, {}, { amount: 0, unit: "days" }, { amount: -3, unit: "days" }, { amount: 1.5, unit: "months" }, { amount: "5", unit: "years" }, { amount: 11, unit: "years" }, { amount: 121, unit: "months" }, { amount: 521, unit: "weeks" }, { amount: 3651, unit: "days" }, { amount: 5, unit: "decades" }]) {
    assert.equal(parseWindow(bad), null, JSON.stringify(bad));
  }
});

test("sample mode serves the closest preset and says when it is not exact", () => {
  const year = projectionFixture({ amount: 1, unit: "years" });
  assert.equal(year.exact, true);
  assert.equal(year.projection.days, 365);
  assert.equal(projectionFixture({ amount: 5, unit: "years" }).projection.days, 1826);
  assert.equal(projectionFixture({ amount: 6, unit: "months" }).exact, true);
  const odd = projectionFixture({ amount: 90, unit: "days" });
  assert.equal(odd.exact, false);
  assert.equal(odd.projection.days, 30); // nearer to 1 month than to 6
  assert.ok(odd.projection.current.points.length > 0 && odd.projection.coach);
});

test("the sample fixture carries the likely range, aligned with its points, and says what it learned", () => {
  for (const unit of [{ amount: 6, unit: "months" as const }, { amount: 5, unit: "years" as const }]) {
    const { projection } = projectionFixture(unit);
    for (const path of [projection.current, projection.coach]) {
      const u = path.uncertainty;
      assert.equal(u.p10.length, path.points.length);
      assert.equal(u.p90.length, path.points.length);
      assert.ok(u.p10.every((lo: number, i: number) => lo <= u.p50[i] && u.p50[i] <= u.p90[i]));
      assert.ok(u.probCheckingNegative >= 0 && u.probCheckingNegative <= 1);
      assert.equal(path.model.kind, "learned");
    }
  }
});

test("live mode asks finance for the window with the shared secret, and passes its answer through", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ schemaVersion: 1, days: 181, current: {}, coach: null }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await loadProjection("http://finance:4000/", "s3cret", false, { amount: 6, unit: "months", compare: true }, fetchImpl);
  assert.equal(r.source, "live");
  assert.equal(r.exact, true);
  assert.equal(calls[0]!.url, "http://finance:4000/tools/project");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["x-huddlr-secret"], "s3cret");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { amount: 6, unit: "months", compare: true });
});

test("when finance cannot be reached the page falls back to the sample, and says why", async () => {
  const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const r = await loadProjection("http://finance:4000", "s", false, { amount: 1, unit: "years" }, down);
  assert.match(r.source, /^fixture \(finance unavailable: finance 503\)$/);
  assert.equal(r.projection.days, 365);
  const refused = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.match((await loadProjection("http://finance:4000", "s", false, { amount: 1, unit: "years" }, refused)).source, /ECONNREFUSED/);
});

test("fixture mode never calls finance", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const r = await loadProjection("http://finance:4000", "s", true, { amount: 1, unit: "years" }, fetchImpl);
  assert.equal(called, false);
  assert.equal(r.source, "fixture");
});

test("the Huddle page script parses, and the old six-week chart is gone", () => {
  const html = readFileSync(new URL("../public/huddle.html", import.meta.url), "utf8");
  const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(js));
  assert.ok(html.includes("Where this is heading"));
  assert.ok(!html.includes("Next 6 weeks in Checking"));
  assert.ok(!html.includes("function timeline("));
  assert.ok(js.includes('API + "/project"'));
  for (const piece of ["Likely range (80%)", "Chance checking dips below $0", "bandPath", "detectedRecurring", "Spending is learned from your last"]) assert.ok(html.includes(piece), piece);
});
