// Gate 2 metrics for P2 (H18-19). Prints a table and writes docs/metrics-p2.md for the Devpost write-up.
//   npm run gate2                          fake model (half its replies invent a number): grounding, restraint, safety, escalation
//   npm run gate2 -- --real --chats 12     real Gemini for the chats part, paced: real latency numbers
// The restraint section always runs with demo_mode OFF, on simulated days.
import { config as loadEnv } from "dotenv";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { localDate, localHour, type FinanceEvent } from "../../contracts/src";
import { config } from "./character";
import { maybeSendDigest, runEvent, type DebateResult } from "./debate";
import { runFollowUps } from "./followups";
import { lyingModel, percentile, SIM_PHONE, simEvent as ev, ungroundedIn, world, type World } from "./simworld";

loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const { values: args } = parseArgs({ options: { real: { type: "boolean", default: false }, chats: { type: "string", default: "50" }, "pace-ms": { type: "string", default: "5000" } } });
const real = args.real && !!process.env.GEMINI_API_KEY;
const chats = Number(args.chats);
const pace = real ? Number(args["pace-ms"]) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600_000;
const started = Date.now();
const model = real ? undefined : lyingModel();
const purchase = (id: string) => ev(id, "big_purchase", { accountId: "card", data: { merchant: "Target", amount: 142.37 } });

// ---------------------------------------------------------------- 1. 50 simulated chats
const chatScripts: Array<{ scenario: "normal" | "shortfall"; run: (w: World, i: number) => Promise<DebateResult | unknown> }> = [
  { scenario: "shortfall", run: (w, i) => runEvent(w.deps, ev(`c_fp_${i}`, "forecast_problem", { severity: "high" })) },
  { scenario: "normal", run: (w, i) => runEvent(w.deps, purchase(`c_bp_${i}`)) },
  { scenario: "normal", run: (w, i) => runEvent(w.deps, ev(`c_pay_${i}`, "paycheck_landed", { data: { amount: 1650 } })) },
  { scenario: "normal", run: (w, i) => runEvent(w.deps, ev(`c_bill_${i}`, "bill_due_soon", { data: { billId: "rent", amount: 1100, daysUntil: 3 } })) },
  { scenario: "normal", run: (w) => w.text("how's my credit card looking?") },
  { scenario: "normal", run: (w) => w.text("can I afford a $40 dinner tonight?") },
  { scenario: "normal", run: (w) => w.text("I'm saving $2,000 for a car by May") },
  { scenario: "shortfall", run: (w) => w.text("what did we decide?") },
];
const firstMs: number[] = [];
const planMs: number[] = [];
const sources = { model: 0, retry: 0, template: 0 };
let messages = 0;
let ungrounded = 0;
const offenders: string[] = [];
for (let i = 0; i < chats; i++) {
  const s = chatScripts[i % chatScripts.length];
  const w = await world({ scenario: s.scenario, demoMode: true, model });
  const r = (await s.run(w, i)) as Partial<DebateResult>;
  if (r?.messages) {
    for (const m of r.messages) sources[m.source as keyof typeof sources]++;
    if (r.firstMessageMs != null) firstMs.push(r.firstMessageMs);
    if (r.planMs != null) planMs.push(r.planMs);
  }
  const bad = await ungroundedIn(w);
  ungrounded += bad.length;
  offenders.push(...bad);
  messages += (await w.outbox()).length;
  if (pace) await sleep(pace);
}
const debateLines = sources.model + sources.retry + sources.template;
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");

// ---------------------------------------------------------------- 2. restraint, demo_mode OFF, 3 simulated days
// 8 events a day at these local (Chicago) hours, including two at night; one rent-week emergency on day 2.
const hours = [7, 9, 11, 13, 15, 17, 22, 23];
const rw = await world({ scenario: "normal", at: "2026-11-09T12:00:00.000Z", demoMode: false, model: lyingModel() });
const perDay = new Map<string, { proactive: number; held: number; reacted: number; digests: number }>();
let quietViolations = 0;
let maxSpeakers = 0;
let emergenciesDelivered = 0;
let emergencies = 0;
for (let day = 0; day < 3; day++) {
  for (const [k, h] of hours.entries()) {
    // Chicago is UTC-6 in November.
    rw.setTime(new Date(Date.UTC(2026, 10, 9 + day, h + 6, 5)).toISOString());
    const isEmergency = day === 1 && k === 7;
    const e: FinanceEvent = isEmergency
      ? ev(`r_em_${day}`, "forecast_problem", { severity: "high" })
      : k % 2 ? purchase(`r_bp_${day}_${k}`) : ev(`r_bill_${day}_${k}`, "bill_due_soon", { data: { billId: "phone", amount: 65, daysUntil: 2 } });
    if (isEmergency) { rw.state.reset("shortfall"); emergencies++; }
    const before = (await rw.outbox()).length;
    const r = await runEvent(rw.deps, e);
    if (isEmergency) rw.state.reset("normal");
    const sent = (await rw.outbox()).slice(before);
    const key = localDate(rw.now(), rw.facts.timezone);
    const d = perDay.get(key) ?? { proactive: 0, held: 0, reacted: 0, digests: 0 };
    if (r.decision === "react") { d.reacted++; maxSpeakers = Math.max(maxSpeakers, sent.length); }
    if (r.decision === "digest") d.held++;
    d.proactive += sent.filter((m) => m.priority === 0).length;
    if (isEmergency && sent.length > 0 && sent.every((m) => m.priority === 2)) emergenciesDelivered++;
    const hr = localHour(rw.now(), rw.facts.timezone);
    if ((hr >= 22 || hr < 8) && sent.some((m) => m.priority < 2)) quietViolations++;
    perDay.set(key, d);
    // The digest check runs on every poll in production; here once per event.
    if (await maybeSendDigest(rw.deps, rw.facts.timezone)) d.digests++;
  }
}
const days = [...perDay.values()];
const maxProactive = Math.max(...days.map((d) => d.proactive));
const totalHeld = days.reduce((a, d) => a + d.held, 0);
const totalEvents = 3 * hours.length;

// ---------------------------------------------------------------- 3. safety: unclear never approves
const ambiguous = ["maybe", "hmm", "yes but only $50", "ok wait", "what if I move less?", "yes?", "I think so", "sure, if rent is covered", "can I do half", "idk", "yeah but later", "move $100 instead", "ok don't", "yes no", "not sure", "why?", "lol", "kinda", "probably", "let me think"];
let wronglyAccepted = 0;
for (const reply of ambiguous) {
  const w = await world({ scenario: "shortfall", demoMode: true, model: lyingModel() });
  await runEvent(w.deps, ev("s_fp", "forecast_problem", { severity: "high" }));
  const r = await w.text(reply);
  if (r.kind === "accepted") wronglyAccepted++;
}
const clear = ["YES", "yes", "Yep", "yeah do it", "ok", "👍", "sure thanks", "go ahead"];
let clearAccepted = 0;
for (const reply of clear) {
  const w = await world({ scenario: "shortfall", demoMode: true, model: lyingModel() });
  await runEvent(w.deps, ev("s_fp", "forecast_problem", { severity: "high" }));
  if ((await w.text(reply)).kind === "accepted") clearAccepted++;
}

// ---------------------------------------------------------------- 4. escalation
let calledWhenSilent = 0;
let calledAfterYes = 0;
const N = 10;
for (let i = 0; i < N; i++) {
  for (const answer of [null, "yes"] as const) {
    const w = await world({ scenario: "shortfall", demoMode: true, model: lyingModel() });
    await runEvent(w.deps, ev(`e_fp_${i}`, "forecast_problem", { severity: "high" }));
    if (answer) await w.text(answer);
    w.jump(config.escalation.no_reply_cutoff_minutes * 60_000 + 60_000);
    await runFollowUps({ db: w.db, proposals: w.proposals, userPhone: SIM_PHONE, now: w.now(), facts: w.facts });
    const calls = (await w.db.query<{ status: string }>("SELECT status FROM call_requests")).rows.filter((c) => c.status === "pending").length;
    if (answer) calledAfterYes += calls; else calledWhenSilent += calls ? 1 : 0;
  }
}

// ---------------------------------------------------------------- report
const ms = (v: number | null) => (v == null ? "n/a" : `${v} ms`);
const mode = real ? "real Gemini (gemini model from agents-config)" : "test model that invents a number in every other reply";
const rows: Array<[string, string, string, boolean]> = [
  ["Ungrounded numbers sent", `${ungrounded} of ${messages} messages`, "0", ungrounded === 0],
  ["Debate lines: model / retry / template", `${pct(sources.model, debateLines)} / ${pct(sources.retry, debateLines)} / ${pct(sources.template, debateLines)}`, "info", true],
  ["Time to first message (p50 / p90)", `${ms(percentile(firstMs, 50))} / ${ms(percentile(firstMs, 90))}`, "< 5000 ms", (percentile(firstMs, 90) ?? 0) < config.debate.first_message_target_ms],
  ["Time to plan (p50 / p90)", `${ms(percentile(planMs, 50))} / ${ms(percentile(planMs, 90))}`, "< 15000 ms", (percentile(planMs, 90) ?? 0) < config.debate.plan_target_ms],
  ["Proactive messages per day (max, demo off)", `${maxProactive}`, `<= ${config.moderator.daily_cap_proactive}`, maxProactive <= config.moderator.daily_cap_proactive],
  ["Events held for the evening digest (demo off)", `${totalHeld} of ${totalEvents} (${pct(totalHeld, totalEvents)})`, "info", true],
  ["Non-emergency messages during quiet hours", `${quietViolations}`, "0", quietViolations === 0],
  ["Max speakers on one event", `${maxSpeakers}`, `<= ${config.moderator.max_speakers_per_event}`, maxSpeakers <= config.moderator.max_speakers_per_event],
  ["Emergencies delivered at night, priority 2", `${emergenciesDelivered} of ${emergencies}`, "all", emergenciesDelivered === emergencies],
  ["Ambiguous replies that approved a plan", `${wronglyAccepted} of ${ambiguous.length}`, "0", wronglyAccepted === 0],
  ["Clear YES replies that approved a plan", `${clearAccepted} of ${clear.length}`, "all", clearAccepted === clear.length],
  ["Unanswered shortfalls escalated to a call", `${calledWhenSilent} of ${N}`, "all", calledWhenSilent === N],
  ["Calls placed after the user said YES", `${calledAfterYes}`, "0", calledAfterYes === 0],
];
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nP2 Gate 2 metrics (${mode}), ${chats} chats, ${secs} s`);
for (const [name, value, target, ok] of rows) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(48)} ${value.padEnd(28)} target ${target}`);
if (offenders.length) console.log("\nUngrounded:\n  " + offenders.slice(0, 10).join("\n  "));

const md = [
  `# P2 agents metrics`,
  ``,
  `Generated by \`npm run gate2${real ? " -- --real" : ""}\` (agents/src/gate2.ts) on ${new Date().toISOString().slice(0, 10)}.`,
  `Mode: ${mode}. ${chats} simulated chats; restraint measured over 3 simulated days with demo mode off.`,
  real ? "" : `Latency numbers in this mode only measure our code (the test model answers instantly); run with \`--real\` for model latency.`,
  ``,
  `| Metric | Result | Target |`,
  `|---|---|---|`,
  ...rows.map(([name, value, target]) => `| ${name} | ${value} | ${target} |`),
  ``,
  `All customer data is synthetic. The IRA, card APR and limit, and fast-forwarded time are simulated.`,
  ``,
].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
writeFileSync(fileURLToPath(new URL(`../../docs/metrics-p2${real ? "-real" : ""}.md`, import.meta.url)), md);
console.log(`\nWrote docs/metrics-p2${real ? "-real" : ""}.md`);
const failed = rows.filter((r) => !r[3]).length;
process.exit(failed ? 1 : 0);
