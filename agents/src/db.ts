// Database access for the agents service. Postgres in production (DATABASE_URL), PGlite in tests.
// Simulated time follows P1's clock rule: now() = real time + sim_state.offset_seconds.
import { readFileSync } from "node:fs";
import pg from "pg";

/** Anything with pg's query shape: a Pool, a PoolClient, or PGlite. Same interface P4's voice service uses. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export function pool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 6 });
}

/** Creates P2's tables. Safe to run on every start (everything is IF NOT EXISTS). */
export async function migrate(db: Queryable & { exec?: (sql: string) => Promise<unknown> }): Promise<void> {
  const sql = readFileSync(new URL("../../contracts/p2_agents.sql", import.meta.url), "utf8");
  // PGlite runs a multi-statement script with exec(); pg's query() does the same when given no parameters.
  if (db.exec) await db.exec(sql);
  else await db.query(sql);
}

export interface SimClockReading {
  now: Date;
  demoMode: boolean;
}

/** Reads sim_state (owned by P1). Falls back to real time and demo off if the table isn't there yet. */
export async function readClock(db: Queryable, realNow = Date.now()): Promise<SimClockReading> {
  try {
    const r = await db.query<{ offset_seconds: number | string; demo_mode: boolean }>("SELECT offset_seconds, demo_mode FROM sim_state LIMIT 1");
    const row = r.rows[0];
    return { now: new Date(realNow + Number(row?.offset_seconds ?? 0) * 1000), demoMode: Boolean(row?.demo_mode) };
  } catch {
    return { now: new Date(realNow), demoMode: false };
  }
}
