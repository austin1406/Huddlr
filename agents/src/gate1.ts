// Gate 1 check for P2. Runs P1's finance stub and the agents in-process on an in-memory Postgres, then checks:
//   1. 30 scripted runs (events + texts) with 0 ungrounded numbers in anything that would be sent
//   2. quiet hours hold (normal event at night -> digest, nothing sent)
//   3. daily cap holds (after the cap, events go to the digest)
//   4. emergencies ignore both
//   5. never react to the same event id twice
//   6. clock test: jump 2 days -> the plan expires, follow-ups fire once, a late YES is answered, not accepted
//   7. reset clears everything
//   8. P1's watcher completing a transfer gets one acknowledgement
//
//   npm run gate1                 fake model that invents a number every other reply (no quota)
//   npm run gate1 -- --real       real Gemini, paced (uses quota)
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TOOL_AUTH_HEADER } from "../../contracts/src";
import { config } from "./character";
import { runEvent } from "./debate";
import { runFollowUps } from "./followups";
import { lyingModel, SIM_PHONE as PHONE, simEvent as ev, ungroundedIn, world as makeWorld, type World } from "./simworld";

loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const { values: args } = parseArgs({ options: { real: { type: "boolean", default: false }, runs: { type: "string", default: "30" }, "pace-ms": { type: "string", default: "4000" } } });
const real = args.real && !!process.env.GEMINI_API_KEY;
const pace = real ? Number(args["pace-ms"]) : 0;
const HOUR = 3600_000;
const model = real ? undefined : lyingModel();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const world = (scenario: "normal" | "shortfall", at?: string, demoMode = false) => makeWorld({ scenario, at, demoMode, model });

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

// ---------------------------------------------------------------- 1. 30 scripted runs
const scripts: Array<(w: World, i: number) => Promise<unknown>> = [
  (w, i) => runEvent(w.deps, ev(`g_bp_${i}`, "big_purchase", { accountId: "card", data: { merchant: "Target", amount: 142.37 } })),
  (w, i) => runEvent(w.deps, ev(`g_pay_${i}`, "paycheck_landed", { severity: "medium", data: { amount: 1650 } })),
  (w, i) => runEvent(w.deps, ev(`g_bill_${i}`, "bill_due_soon", { data: { billId: "rent", amount: 1100, daysUntil: 3 } })),
  (w) => w.text("how is my credit card doing?"),
  (w) => w.text("can I afford a $40 dinner tonight?"),
  (w) => w.text("I want to save $2,000 for a car by May"),
];
const runs = Number(args.runs);
const started = Date.now();
let totalBad = 0;
let totalMessages = 0;
let firstMs: number[] = [];
for (let i = 0; i < runs; i++) {
  const scenario = i % 3 === 2 ? "shortfall" : "normal";
  const w = await world(scenario, undefined, true);
  const r = await scripts[i % scripts.length](w, i);
  if (scenario === "shortfall") {
    const e = await runEvent(w.deps, ev(`g_fp_${i}`, "forecast_problem", { severity: "high" }));
    if (e.firstMessageMs != null) firstMs.push(e.firstMessageMs);
    await w.text(i % 2 ? "yes" : "maybe?");
  }
  const rr = r as { firstMessageMs?: number | null };
  if (rr?.firstMessageMs != null) firstMs.push(rr.firstMessageMs);
  const bad = await ungroundedIn(w);
  totalBad += bad.length;
  totalMessages += (await w.outbox()).length;
  if (bad.length) console.log(`  run ${i + 1}: ${bad.join(" | ")}`);
  if (pace) await sleep(pace);
}
firstMs = firstMs.sort((a, b) => a - b);
check(`${runs} scripted runs, 0 ungrounded numbers`, totalBad === 0, `${totalMessages} messages, ${totalBad} ungrounded`);

// ---------------------------------------------------------------- 2-4. quiet hours, cap, emergencies
{
  const w = await world("normal", "2026-11-08T05:00:00.000Z"); // 11 pm Chicago
  const r = await runEvent(w.deps, ev("q1", "big_purchase", { accountId: "card", data: { merchant: "Target", amount: 142.37 } }));
  check("quiet hours: a normal event at 11 pm is held for the digest", r.decision === "digest" && (await w.outbox()).length === 0, r.reason);
}
{
  const w = await world("normal", "2026-11-07T20:00:00.000Z"); // 2 pm Chicago
  const decisions: string[] = [];
  for (let i = 0; i < 5; i++) decisions.push((await runEvent(w.deps, ev(`cap${i}`, "big_purchase", { accountId: "card", data: { merchant: "Target", amount: 142.37 } }))).decision);
  const proactive = (await w.outbox()).filter((m) => m.priority === 0).length;
  const cap: number = config.moderator.daily_cap_proactive;
  check("daily cap: proactive messages stop at the cap, the rest go to the digest", proactive <= cap && decisions.includes("digest"), `${proactive} of ${cap} proactive sent; ${decisions.join(",")}`);
}
{
  const w = await world("shortfall", "2026-12-03T05:00:00.000Z");
  const r = await runEvent(w.deps, ev("em1", "forecast_problem", { severity: "high" }));
  const sent = await w.outbox();
  check("emergency at night ignores quiet hours, priority 2", r.decision === "react" && sent.length > 0 && sent.every((m) => m.priority === 2), r.reason);
  if (pace) await sleep(pace);
}

// ---------------------------------------------------------------- 5. duplicates
{
  const w = await world("normal", undefined, true);
  const e = ev("dup1", "big_purchase", { accountId: "card", data: { merchant: "Target", amount: 142.37 } });
  await runEvent(w.deps, e);
  const n = (await w.outbox()).length;
  const again = await runEvent(w.deps, e);
  check("same event id never reacted to twice", again.decision === "duplicate" && (await w.outbox()).length === n);
  if (pace) await sleep(pace);
}

// ---------------------------------------------------------------- 6. clock test (jump 2 days)
{
  const w = await world("shortfall", undefined, true);
  await runEvent(w.deps, ev("clk1", "forecast_problem", { severity: "high" }));
  const before = await w.proposals.getPending(PHONE);
  w.jump(2 * 24 * HOUR);
  const fired = await runFollowUps({ db: w.db, proposals: w.proposals, userPhone: PHONE, now: w.now(), facts: w.facts });
  const after = await w.proposals.getPending(PHONE);
  const late = await w.text("yes");
  const again = await runFollowUps({ db: w.db, proposals: w.proposals, userPhone: PHONE, now: w.now(), facts: w.facts });
  check(
    "clock test: +2 days expires the plan, follow-ups fire once and stand down, a late YES is answered not accepted",
    !!before && after === null && fired.length === 2 && fired.every((f) => f.outcome === "skipped") && late.kind === "expired" && again.length === 0,
    `pending before=${!!before} after=${after !== null}; follow-ups=${fired.map((f) => f.outcome).join(",")}; late YES=${late.kind}`,
  );
  if (pace) await sleep(pace);
}

// ---------------------------------------------------------------- 7-8. reset, transfer ack
{
  const w = await world("shortfall", undefined, true);
  await runEvent(w.deps, ev("rst1", "forecast_problem", { severity: "high" }));
  const p = await w.proposals.getPending(PHONE);
  const call = (path: string, body?: unknown) =>
    w.app.request(`/agents${path}`, { method: "POST", headers: { "content-type": "application/json", [TOOL_AUTH_HEADER]: "k" }, body: JSON.stringify(body ?? {}) });
  const c1 = await call(`/proposals/${p!.id}/complete`, { txnId: "nessie-xfer-1" });
  const c2 = await call(`/proposals/${p!.id}/complete`, { txnId: "nessie-xfer-1" });
  const acks = (await w.outbox()).filter((m) => /Saw it/.test(m.text)).length;
  check("transfer completed by P1's watcher: acknowledged exactly once", c1.status === 200 && c2.status === 409 && acks === 1, `HTTP ${c1.status}/${c2.status}, ${acks} ack`);
  const r = await call("/reset");
  const left = await w.db.query<{ n: number }>("SELECT (SELECT count(*) FROM outbox) + (SELECT count(*) FROM proposals) + (SELECT count(*) FROM agent_state) AS n");
  check("reset-agents clears P2's tables", r.status === 200 && Number(left.rows[0].n) === 0);
}

// ---------------------------------------------------------------- report
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
console.log(`\nP2 Gate 1 (${real ? "real Gemini" : "fake model, half its replies invent a number"}) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${pad(r.name, 96)} ${r.detail}`);
if (firstMs.length) console.log(`time to first message: median ${firstMs[Math.floor(firstMs.length / 2)]} ms, max ${firstMs.at(-1)} ms (${firstMs.length} debates)`);
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nAll Gate 1 checks passed");
process.exit(failed ? 1 : 0);
