import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Anything with query(text, params) -> { rows } (pg.Pool in production, PGlite in tests). */
export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type ChatLine = {
  at: string; // ISO, real clock (order of arrival)
  from: "user" | string; // "user" or a cast id / "system"
  text: string;
  status?: string; // outbox status for our messages
  photo?: boolean;
};

const fixture = () =>
  JSON.parse(readFileSync(fileURLToPath(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url)), "utf8"));

/** P1's facts snapshot. Falls back to the contract fixture when finance is unreachable (local preview). */
export async function loadFacts(financeUrl: string, secret: string, useFixture: boolean): Promise<{ facts: any; source: string }> {
  if (useFixture) return { facts: fixture(), source: "fixture" };
  try {
    const res = await fetch(`${financeUrl.replace(/\/$/, "")}/facts`, {
      headers: secret ? { "x-huddlr-secret": secret } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`finance ${res.status}`);
    return { facts: await res.json(), source: "live" };
  } catch (err) {
    return { facts: fixture(), source: `fixture (finance unavailable: ${(err as Error).message})` };
  }
}

/** The demo user's conversation: what they sent and what the cast sent back, oldest first. */
export async function loadChat(db: Db, phone: string, limit = 40): Promise<ChatLine[]> {
  const r = await db.query<{ at: Date; from: string; text: string | null; status: string | null; photo: boolean }>(
    `SELECT * FROM (
       SELECT received_at AS at, 'user' AS "from", text, NULL AS status, cardinality(attachment_ids) > 0 AS photo
         FROM inbound_messages WHERE user_phone = $1
       UNION ALL
       SELECT created_at AS at, speaker AS "from", text, status, false AS photo
         FROM outbox WHERE user_phone = $1
     ) t ORDER BY at DESC LIMIT $2`,
    [phone, limit],
  );
  return r.rows
    .reverse()
    .map((x) => ({ at: new Date(x.at).toISOString(), from: x.from, text: hideCodes(x.text ?? ""), status: x.status ?? undefined, photo: x.photo || undefined }));
}

/** Login codes show on the projector as ••••••. */
export const hideCodes = (text: string) => text.replace(/(Huddle code is )\d{6}/, "$1••••••");

/** Queue health: how many messages are waiting, held, failed, or went out. */
export async function loadOutboxStats(db: Db): Promise<Record<string, number>> {
  const r = await db.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM outbox GROUP BY status`);
  const out: Record<string, number> = { pending: 0, sending: 0, sent: 0, held: 0, failed: 0 };
  for (const row of r.rows) out[row.status] = Number(row.n);
  return out;
}

/** Most recent proposals with their status (the agents service owns the table; we only read). */
export async function loadProposals(db: Db, phone: string, limit = 5) {
  const r = await db.query(
    `SELECT id, action_text, amount_cents, status, channel, expires_at, decided_sim_at, completed_sim_at
       FROM proposals WHERE user_phone = $1 ORDER BY id DESC LIMIT $2`,
    [phone, limit],
  );
  return r.rows.map((p: any) => ({
    id: Number(p.id),
    actionText: p.action_text,
    amount: Number(p.amount_cents) / 100,
    status: p.status,
    channel: p.channel,
    expiresAt: p.expires_at,
  }));
}

/** Mask a phone for display on a projector: +1 (•••) •••-1234. */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.length >= 4 ? `•••-${d.slice(-4)}` : "•••";
}
