import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Anything with query(text, params) -> { rows } (pg.Pool in production, PGlite in tests). */
export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run several statements at once (PGlite). pg.Pool does this through query() with no params. */
  exec?(text: string): Promise<unknown>;
}

const runScript = (db: Db, sql: string) => (db.exec ? db.exec(sql) : db.query(sql));

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 5 });
}

/**
 * Make sure the tables we touch exist. P2 owns inbound_messages/outbox (their SQL is
 * idempotent: CREATE ... IF NOT EXISTS), so running it is safe. P3 owns p3_* tables.
 */
export async function migrate(db: Db): Promise<void> {
  const p2 = readFileSync(fileURLToPath(new URL("../../contracts/p2_agents.sql", import.meta.url)), "utf8");
  await runScript(db, p2);
  await runScript(db, `
    CREATE TABLE IF NOT EXISTS p3_photon_spaces (
      user_phone      TEXT PRIMARY KEY,          -- E.164, the human
      space_id        TEXT NOT NULL,             -- Photon conversation id
      agent_user_id   TEXT NOT NULL,             -- Photon user id of OUR agent in that space (senderId)
      agent_handle    TEXT,                      -- the agent number this person texts
      last_inbound_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS p3_outbox_sends (
      outbox_id        BIGINT PRIMARY KEY,
      provider_msg_id  TEXT,                     -- Photon message id returned on send
      delivered_at     TIMESTAMPTZ
    );
  `);
}

/** Simulated now (shared clock). P1 owns sim_state; if it doesn't exist yet, real time. */
export async function simNow(db: Db): Promise<{ now: Date; demoMode: boolean }> {
  try {
    const r = await db.query<{ offset_seconds: string | number; demo_mode: boolean }>(
      "SELECT offset_seconds, demo_mode FROM sim_state LIMIT 1",
    );
    const row = r.rows[0];
    if (row) return { now: new Date(Date.now() + Number(row.offset_seconds) * 1000), demoMode: !!row.demo_mode };
  } catch {
    /* table not created yet */
  }
  return { now: new Date(), demoMode: false };
}
