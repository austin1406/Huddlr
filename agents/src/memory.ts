// Memory shared by text and voice. Messages are saved as they happen (outbox.ts, replies.ts, P4's voice service).
// This file pulls durable facts out of what the user says: goals and preferences, saved to memory_facts.
// Pattern-based on purpose: no model call, so it costs no quota and can't invent a goal.
import type { Queryable } from "./db";

export interface Learned {
  kind: "goal" | "preference";
  key: string;
  value: Record<string, unknown>;
  /** Short confirmation the Coach can send. Uses only the user's own words and numbers. */
  ack: string;
}

const money = (s: string) => Number(s.replace(/[$,]/g, ""));
const clean = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
const slug = (s: string) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export function extractMemory(text: string): Learned[] {
  const t = text.trim();
  const out: Learned[] = [];

  // "saving for a trip to Japan", "I want to save $2,000 for a car by May", "goal: new laptop $1200"
  const goal =
    t.match(/\bsav(?:e|ing)\s+(?:up\s+)?(\$[\d,]+(?:\.\d+)?)?\s*(?:up\s+)?for\s+(?:a |an |my |the )?([a-z][\w\s'-]{1,40}?)(?:\s+by\s+([\w\s]{2,20}?))?(?:\s*[.,!?]|\s+and\b|$)/i) ??
    t.match(/\bgoal(?:\s+is)?\s*[:-]?\s*(?:to\s+)?(?:save\s+)?(\$[\d,]+(?:\.\d+)?)?\s*(?:for\s+)?(?:a |an |my |the )?([a-z][\w\s'-]{1,40}?)(?:\s+\$[\d,]+(?:\.\d+)?)?(?:\s+by\s+([\w\s]{2,20}?))?(?:\s*[.,!?]|$)/i);
  if (goal) {
    const label = clean(goal[2]);
    const amountText = goal[1] ?? t.match(/\$[\d,]+(?:\.\d+)?/)?.[0];
    const target = amountText ? money(amountText) : undefined;
    const by = goal[3] ? clean(goal[3]) : undefined;
    out.push({
      kind: "goal",
      key: `goal:${slug(label)}`,
      value: { label, ...(target ? { target } : {}), ...(by ? { by } : {}) },
      ack: `Noted your ${label} goal${target ? `: ${amountText}` : ""}${by ? ` by ${by}` : ""}. The crew will keep it in mind.`,
    });
  }

  // "don't text me after 9pm", "no messages before 10am"
  const quiet = t.match(/\b(?:don'?t|do not|no|stop)\s+(?:text(?:ing)?|messag(?:e|es|ing))\s+(?:me\s+)?(after|before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (quiet) {
    let hour = Number(quiet[2]) % 12;
    const ampm = quiet[4]?.toLowerCase() ?? (quiet[1].toLowerCase() === "after" ? "pm" : "am");
    if (ampm === "pm") hour += 12;
    const which = quiet[1].toLowerCase() === "after" ? "quiet_start_hour" : "quiet_end_hour";
    out.push({
      kind: "preference",
      key: `pref:${which}`,
      value: { hour, minute: Number(quiet[3] ?? 0) },
      ack: `Got it, no texts ${quiet[1].toLowerCase()} ${quiet[2]}${quiet[3] ? `:${quiet[3]}` : ""}${quiet[4] ?? ampm} unless it's an emergency.`,
    });
  }

  // "text me less", "fewer messages", "too many texts"
  if (/\b(text|message)\s+me\s+less\b|\bfewer\s+(texts|messages)\b|\btoo\s+many\s+(texts|messages)\b/i.test(t)) {
    out.push({ kind: "preference", key: "pref:fewer_messages", value: { enabled: true }, ack: "Got it, we'll keep it quieter and save more for the evening recap." });
  }
  return out;
}

/** Upserts each learned fact. Returns how many were saved. */
export async function saveMemory(db: Queryable, userPhone: string, learned: Learned[], now: Date, source: "text" | "voice" = "text"): Promise<number> {
  for (const l of learned)
    await db.query(
      `INSERT INTO memory_facts (user_phone, kind, key, value, source, created_sim_at, updated_sim_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (user_phone, key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_sim_at = EXCLUDED.updated_sim_at`,
      [userPhone, l.kind, l.key, JSON.stringify(l.value), source, now],
    );
  return learned.length;
}

/** Goals and preferences for prompts and the moderator. */
export async function loadMemory(db: Queryable, userPhone: string): Promise<Array<{ kind: string; key: string; value: unknown }>> {
  const r = await db.query<{ kind: string; key: string; value: unknown }>(
    "SELECT kind, key, value FROM memory_facts WHERE user_phone = $1 ORDER BY updated_sim_at DESC LIMIT 20",
    [userPhone],
  );
  return r.rows.map((row) => ({ ...row, value: typeof row.value === "string" ? JSON.parse(row.value) : row.value }));
}
