// Local-only helpers (npm run local). Never mounted in production.
//   POST /agents/dev/text   {"text":"YES"}          pretend the user texted the line (what P3's webhook would write)
//   GET  /agents/dev/chat                           the conversation so far, formatted like the phone shows it
//   POST /agents/dev/jump   {"hours":2}              fast-forward simulated time (writes a local sim_state row)
//   POST /agents/dev/demo   {"on":true}              toggle demo_mode
import type { Hono } from "hono";
import { cast } from "./character";
import type { Queryable } from "./db";
import type { Finance } from "./finance";

export function devRoutes(app: Hono, deps: { db: Queryable; userPhone: string; now: () => Promise<Date>; finance: Finance }) {
  const { db, userPhone } = deps;
  const simState = async () => {
    // sim_state belongs to P1; locally there is none, so create a stand-in with the same columns.
    await db.query("CREATE TABLE IF NOT EXISTS sim_state (id INT PRIMARY KEY DEFAULT 1, offset_seconds BIGINT NOT NULL DEFAULT 0, demo_mode BOOLEAN NOT NULL DEFAULT false)");
    await db.query("INSERT INTO sim_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  };

  app.post("/dev/text", async (c) => {
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
    if (!text) return c.json({ error: "text required" }, 400);
    const r = await db.query<{ id: number }>(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, userPhone, text, await deps.now()],
    );
    return c.json({ inboundId: Number(r.rows[0].id), note: "handled within ~1 s; then GET /agents/dev/chat" });
  });

  app.get("/dev/chat", async (c) => {
    const r = await db.query<{ direction: string; speaker: string; text: string; created_sim_at: string | Date }>(
      "SELECT direction, speaker, text, created_sim_at FROM memory_messages WHERE user_phone = $1 ORDER BY id DESC LIMIT 40",
      [userPhone],
    );
    const lines = r.rows.reverse().map((m) => {
      if (m.direction === "in") return `   you: ${m.text}`;
      const who = cast.find((x) => x.id === m.speaker);
      return `${who?.emoji ?? "•"} ${who?.name ?? m.speaker}: ${m.text}`;
    });
    const calls = await db.query<{ id: number; status: string; script_hint: string }>("SELECT id, status, script_hint FROM call_requests ORDER BY id");
    for (const call of calls.rows) lines.push(`📞 call_request ${call.id} (${call.status}): ${call.script_hint}`);
    return c.text(lines.join("\n") + "\n");
  });

  app.post("/dev/jump", async (c) => {
    const { hours = 1 } = (await c.req.json().catch(() => ({}))) as { hours?: number };
    await simState();
    await db.query("UPDATE sim_state SET offset_seconds = offset_seconds + $1 WHERE id = 1", [Math.round(hours * 3600)]);
    return c.json({ now: (await deps.now()).toISOString() });
  });

  app.post("/dev/demo", async (c) => {
    const { on = true } = (await c.req.json().catch(() => ({}))) as { on?: boolean };
    await simState();
    await db.query("UPDATE sim_state SET demo_mode = $1 WHERE id = 1", [on]);
    return c.json({ demoMode: on });
  });
}
