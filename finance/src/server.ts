import { serve } from "@hono/node-server";
import { join } from "node:path";
import pg from "pg";
import { createApp } from "./app";
import type { Backend } from "./backend";
import { PERSONA } from "./data/config";
import { EngineBackend, SOURCE_POLL_MS } from "./engine/backend";
import { NessieClient } from "./nessie/client";
import { NessieSource, type TxnSource } from "./nessie/source";
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
  let source: TxnSource | undefined;
  let sourceError: string | undefined;
  if (env.dataSource === "nessie") {
    try {
      if (!env.nessieKey) throw new Error("NESSIE_API_KEY is not set");
      const [firstName, ...rest] = (env.nessieCustomer || `${PERSONA.customer.firstName} ${PERSONA.customer.lastName}`).split(" ");
      source = await NessieSource.connect(new NessieClient(env.nessieBaseUrl, env.nessieKey), { firstName: firstName!, lastName: rest.join(" ") });
      console.log("transaction log: nessie");
    } catch (err) {
      // Stay up on the persona alone rather than failing the demo; /health shows why.
      sourceError = `nessie unavailable, running on the persona alone: ${(err as Error).message}`;
      console.warn(`[finance] ${sourceError}`);
    }
  }
  return EngineBackend.create({
    persona: PERSONA,
    store,
    source,
    sourceError,
    gateway: new HttpProposalGateway(env.agentsUrl, env.huddlrSecret, { db }),
    dataFile: join(env.dataDir, "ledger.json"),
  });
}

const backend = await makeBackend();
const app = createApp({ secret: env.huddlrSecret, backend });

// Read the transaction log in the background so new records become events even when nobody is asking.
if (backend instanceof EngineBackend) setInterval(() => void backend.refresh().catch((err) => console.warn(`[finance] refresh failed: ${err.message}`)), SOURCE_POLL_MS * 1.5).unref();

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`finance listening on :${info.port} (mode: ${env.mode})`);
});
