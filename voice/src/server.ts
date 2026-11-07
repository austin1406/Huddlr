import { serve } from "@hono/node-server";
import { app } from "./app";
import { hasDatabase } from "./db";
import { env } from "./env";
import { startPoller } from "./poller";

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[voice] listening on :${info.port}`);
  if (!env.elevenLabsWebhookSecret) console.warn("[voice] ELEVENLABS_WEBHOOK_SECRET not set: post-call webhooks will be rejected");
  if (!env.databaseUrl) console.warn("[voice] DATABASE_URL not set: calls are logged, not saved");
  if (!env.financeUrl) console.warn("[voice] FINANCE_URL/PUBLIC_BASE_URL not set: calls start without context");

  if (!env.outboundEnabled) console.log("[voice] outbound calls off (VOICE_OUTBOUND=off)");
  else if (!hasDatabase) console.warn("[voice] outbound calls off: needs DATABASE_URL to read call_requests");
  else {
    if (!env.optedInNumbers.length) console.warn("[voice] no opted-in numbers: every call request will be cancelled");
    startPoller();
    console.log(`[voice] polling call_requests; opted in: ${env.optedInNumbers.length} number(s)`);
  }
});
