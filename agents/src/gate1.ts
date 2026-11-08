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
import { PGlite } from "@electric-sql/pglite";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Plan, TOOL_AUTH_HEADER, type CharacterId, type FinanceEvent } from "../../contracts/src";
import { createApp as createFinanceApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { createApp } from "./app";
import { factsFor } from "./character";
import { handleChat } from "./chat";
import { checkMessage, extractNumbers } from "./checker";
import { migrate } from "./db";
import { runEvent, type DebateDeps } from "./debate";
import { financeClient } from "./finance";
import { runFollowUps } from "./followups";
import { makeProposalService } from "./proposals";
import { handleInbound } from "./replies";

loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const { values: args } = parseArgs({ options: { real: { type: "boolean", default: false }, runs: { type: "string", default: "30" }, "pace-ms": { type: "string", default: "4000" } } });
const real = args.real && !!process.env.GEMINI_API_KEY;
const pace = real ? Number(args["pace-ms"]) : 0;
const PHONE = "+15555550100";
const HOUR = 3600_000;

/** Every other reply invents a number, so the checker is exercised on half the calls. */
let fakeCalls = 0;
const fake = async (prompt: string) => {
  fakeCalls++;
  const num = prompt.match(/"balance":(\d+(?:\.\d+)?)/)?.[1];
  return fakeCalls % 2 ? `That is $9,999.99 you will never see again.` : num ? `I'm sitting at $${num} right now.` : "Let's take this one step at a time.";
};
const model = real ? undefined : fake;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function world(scenario: "normal" | "shortfall", at?: string, demoMode = false) {
  const db = new PGlite();
  await migrate(db);
  const state = new StubState(scenario);
  const fin = createFinanceApp({ secret: "", state });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => fin.request(u.replace("http://f", ""), i)) as typeof fetch);
  const facts = await finance.facts();
  let t = new Date(at ?? facts.asOf).getTime();
  const now = () => new Date(t);
  const proposals = makeProposalService(db, now);
  const deps: DebateDeps = { db, finance, proposals, userPhone: PHONE, clock: async () => ({ now: now(), demoMode }), model };
  const app = createApp({ db, proposals, secret: "k", demoUserPhone: PHONE, now });
  let n = 0;
  const text = async (body: string) => {
    const r = await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`gate-${++n}`, PHONE, body, now()],
    );
    const id = Number(r.rows[0].id);
    const res = await handleInbound(db, proposals, { id, user_phone: PHONE, text: body }, now());
    if (res.kind === "chat") await handleChat({ db, facts: () => finance.facts(), userPhone: PHONE, model }, { id, text: body }, now());
    return res;
  };
  const outbox = async () =>
    (await db.query<{ id: number; speaker: string; text: string; event_id: string | null; proposal_id: number | null; reply_to: number | null; priority: number }>(
      "SELECT id, speaker, text, event_id, proposal_id, reply_to, priority FROM outbox ORDER BY id",
    )).rows;
  return { db, state, finance, facts, proposals, deps, app, text, outbox, now, jump: (ms: number) => { t += ms; } };
}

type World = Awaited<ReturnType<typeof world>>;

/** Re-checks every queued message against exactly what its speaker was allowed to use. */
async function ungroundedIn(w: World) {
  const bad: string[] = [];
  const reactions = await w.db.query<{ event_id: string; event: FinanceEvent | string }>("SELECT event_id, event FROM agent_event_reactions");
  const events = new Map(reactions.rows.map((r) => [r.event_id, typeof r.event === "string" ? JSON.parse(r.event) : r.event]));
  const inbound = await w.db.query<{ id: number; text: string }>("SELECT id, text FROM inbound_messages");
  const said = new Map(inbound.rows.map((r) => [Number(r.id), r.text]));
  const goals = (await w.db.query<{ value: unknown }>("SELECT value FROM memory_facts")).rows.map((r) => (typeof r.value === "string" ? JSON.parse(r.value) : r.value));
  for (const m of await w.outbox()) {
    const sources: unknown[] = [factsFor(m.speaker as CharacterId, w.facts, m.event_id ? events.get(m.event_id) ?? null : undefined), goals];
    if (m.proposal_id != null) {
      const p = await w.db.query<{ plan: unknown }>("SELECT plan FROM proposals WHERE id = $1", [m.proposal_id]);
      if (p.rows[0]) sources.push(Plan.parse(typeof p.rows[0].plan === "string" ? JSON.parse(p.rows[0].plan as string) : p.rows[0].plan));
    }
    if (m.reply_to != null) sources.push(extractNumbers(said.get(Number(m.reply_to)) ?? "").map((f) => f.value ?? 0));
    if (m.speaker === "coach" && !m.event_id) sources.push(w.facts); // Coach acks and digests are templated from the facts
    const r = checkMessage(m.text, ...sources);
    if (!r.ok) bad.push(`${m.speaker}: "${m.text}" -> ${r.ungrounded.map((u) => u.raw).join(", ")}`);
  }
  return bad;
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const ev = (id: string, type: FinanceEvent["type"], over: Partial<FinanceEvent> = {}): FinanceEvent => ({
  id, type, occurredAt: "2026-11-07T16:00:00.000Z", severity: "medium", accountId: "checking", data: {}, ...over,
});

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
    const e = (await runEvent(w.deps, ev(`g_fp_${i}`, "forecast_problem", { severity: "high" }))) as { firstMessageMs: number | null };
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
  check("daily cap: proactive messages stop at the cap, the rest go to the digest", proactive <= 6 && decisions.includes("digest"), `${proactive} proactive sent; ${decisions.join(",")}`);
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
