import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { env } from "./env";
import { StubState } from "./state";

if (!env.huddlrSecret) console.warn("HUDDLR_SECRET is not set: auth is off (local development only)");

const app = createApp({ secret: env.huddlrSecret, state: new StubState(env.scenario) });

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`finance stub listening on :${info.port} (scenario: ${env.scenario})`);
});
