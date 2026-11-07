import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SimState, type SimStateStore } from "../../contracts/src";

/** Anything with pg's query shape: a Pool, or PGlite in tests. Same shape the agents and voice services use. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * The shared `sim_state` row. P1 owns the table; the agents service reads `offset_seconds` and `demo_mode` from it
 * (see agents/src/db.ts readClock), so the column names here must not change.
 */
export class PgSimStateStore implements SimStateStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly db: Queryable) {}

  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      await this.db.query(
        "CREATE TABLE IF NOT EXISTS sim_state (id INT PRIMARY KEY DEFAULT 1, offset_seconds BIGINT NOT NULL DEFAULT 0, demo_mode BOOLEAN NOT NULL DEFAULT false)",
      );
      await this.db.query("ALTER TABLE sim_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()");
      await this.db.query("INSERT INTO sim_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    })();
    return this.ready;
  }

  async read(): Promise<SimState> {
    await this.ensure();
    const r = await this.db.query<{ offset_seconds: string | number; demo_mode: boolean; updated_at: Date | string }>(
      "SELECT offset_seconds, demo_mode, updated_at FROM sim_state WHERE id = 1",
    );
    const row = r.rows[0];
    return {
      offsetSeconds: Number(row?.offset_seconds ?? 0),
      demoMode: Boolean(row?.demo_mode),
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  async write(next: SimState): Promise<void> {
    await this.ensure();
    await this.db.query("UPDATE sim_state SET offset_seconds = $1, demo_mode = $2, updated_at = $3 WHERE id = 1", [
      next.offsetSeconds,
      next.demoMode,
      next.updatedAt,
    ]);
  }
}

/** Fallback when there is no database yet. Fine for one process; the other services cannot see it. */
export class FileSimStateStore implements SimStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<SimState> {
    try {
      return SimState.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return { offsetSeconds: 0, demoMode: false, updatedAt: new Date().toISOString() };
    }
  }

  async write(next: SimState): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.path);
  }
}
