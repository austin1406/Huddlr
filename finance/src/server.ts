import { serve } from "@hono/node-server";
import { join } from "node:path";
import pg from "pg";
import { createApp } from "./app";
import type { Backend } from "./backend";
import { PERSONA } from "./data/config";
import { EngineBackend } from "./engine/backend";
import { env } from "./env";
import { HttpProposalGateway } from "./proposals";
import { FileSimStateStore, PgSimStateStore } from "./sim";
import { StubBackend } from "./stub/backend";
import { StubState } from "./stub/state";

if (!env.huddlrSecret) console.warn("HUDDLR_SECRET is not set: auth is off (local development only)");

async function makeBackend(): Promise<Backend> {
  if (env.mode === "stub") return new StubBackend(new StubState(env.scenario));
  const db = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 3 }) : undefined;
  const store = db ? new PgSimStateStore(db) : new FileSimStateStore(join(env.dataDir, "sim_state.json"));
  if (!env.databaseUrl) console.warn("DATABASE_URL is not set: the sim clock is kept in a local file the other services cannot see");
  return EngineBackend.create({
    persona: PERSONA,
    store,
    gateway: new HttpProposalGateway(env.agentsUrl, env.huddlrSecret, { db }),
    dataFile: join(env.dataDir, "ledger.json"),
  });
}

const app = createApp({ secret: env.huddlrSecret, backend: await makeBackend() });

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`finance listening on :${info.port} (mode: ${env.mode})`);
});
