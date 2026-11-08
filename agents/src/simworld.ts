// A self-contained world for gates and metrics: P1's finance stub + the agents + an in-memory Postgres,
// with a simulated clock we can move. Nothing here talks to the network except Gemini (when no fake model is given).
import { PGlite } from "@electric-sql/pglite";
import { Plan, type CharacterId, type FinanceEvent } from "../../contracts/src";
import { createApp as createFinanceApp } from "../../finance/src/app";
import { StubState } from "../../finance/src/state";
import { createApp } from "./app";
import { factsFor } from "./character";
import { handleChat } from "./chat";
import { checkMessage, extractNumbers } from "./checker";
import { migrate } from "./db";
import type { DebateDeps } from "./debate";
import { financeClient } from "./finance";
import { makeProposalService } from "./proposals";
import { handleInbound } from "./replies";

export const SIM_PHONE = "+15555550100";
export type Model = ((prompt: string) => Promise<string>) | undefined;

export async function world(opts: { scenario: "normal" | "shortfall"; at?: string; demoMode?: boolean; model?: Model }) {
  const db = new PGlite();
  await migrate(db);
  const state = new StubState(opts.scenario);
  const fin = createFinanceApp({ secret: "", state });
  const finance = financeClient("http://f", "", 4000, ((u: string, i?: RequestInit) => fin.request(u.replace("http://f", ""), i)) as typeof fetch);
  const facts = await finance.facts();
  let t = new Date(opts.at ?? facts.asOf).getTime();
  let demoMode = opts.demoMode ?? false;
  const now = () => new Date(t);
  const proposals = makeProposalService(db, now);
  const deps: DebateDeps = { db, finance, proposals, userPhone: SIM_PHONE, clock: async () => ({ now: now(), demoMode }), model: opts.model };
  const app = createApp({ db, proposals, secret: "k", demoUserPhone: SIM_PHONE, now });
  let n = 0;
  /** The user texts the line (what P3's webhook would write), then the agents handle it. */
  const text = async (body: string) => {
    const r = await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`sim-${++n}-${Math.random()}`, SIM_PHONE, body, now()],
    );
    const id = Number(r.rows[0].id);
    const res = await handleInbound(db, proposals, { id, user_phone: SIM_PHONE, text: body }, now());
    if (res.kind === "chat") await handleChat({ db, facts: () => finance.facts(), userPhone: SIM_PHONE, model: opts.model }, { id, text: body }, now());
    return res;
  };
  const outbox = async () =>
    (await db.query<{ id: number; speaker: string; text: string; event_id: string | null; proposal_id: number | null; reply_to: number | null; priority: number; created_sim_at: unknown }>(
      "SELECT id, speaker, text, event_id, proposal_id, reply_to, priority, created_sim_at FROM outbox ORDER BY id",
    )).rows;
  return {
    db, state, finance, facts, proposals, deps, app, text, outbox, now,
    jump: (ms: number) => { t += ms; },
    setTime: (iso: string) => { t = new Date(iso).getTime(); },
    setDemoMode: (on: boolean) => { demoMode = on; },
  };
}

export type World = Awaited<ReturnType<typeof world>>;

/** Re-checks every queued message against exactly what its speaker was allowed to use. Returns the offenders. */
export async function ungroundedIn(w: World): Promise<string[]> {
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

export const simEvent = (id: string, type: FinanceEvent["type"], over: Partial<FinanceEvent> = {}): FinanceEvent => ({
  id, type, occurredAt: "2026-11-07T16:00:00.000Z", severity: "medium", accountId: "checking", data: {}, ...over,
});

/** Fake model: every other reply invents a number, so the checker is exercised on half the calls. */
export function lyingModel(): (prompt: string) => Promise<string> {
  let calls = 0;
  return async (prompt) => {
    calls++;
    const num = prompt.match(/"balance":(\d+(?:\.\d+)?)/)?.[1];
    return calls % 2 ? "That is $9,999.99 you will never see again." : num ? `I'm sitting at $${num} right now.` : "Let's take this one step at a time.";
  };
}

export const percentile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
