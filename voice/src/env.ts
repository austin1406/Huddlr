import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export const env = {
  port: Number(process.env.VOICE_PORT || 6000),
  /** P3's fixed domain. Tool URLs the voice agent calls are built from it. */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  /** Where this service reaches the finance API. Defaults to the public domain. */
  financeUrl: (process.env.FINANCE_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  huddlrSecret: process.env.HUDDLR_SECRET || "",
  demoUserPhone: process.env.DEMO_USER_PHONE || "",
  databaseUrl: process.env.DATABASE_URL || "",
  elevenLabsWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
  elevenLabsAgentId: process.env.ELEVENLABS_AGENT_ID || "",
  /** The imported Photon number's id in ElevenLabs (Phone Numbers page). Needed for outbound calls. */
  elevenLabsPhoneNumberId: process.env.ELEVENLABS_PHONE_NUMBER_ID || "",
  /** Comma-separated E.164 numbers that agreed to be called. Defaults to the demo user only. */
  optedInNumbers: (process.env.VOICE_OPTED_IN_NUMBERS || process.env.DEMO_USER_PHONE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Inbound callers who get account details. A demo convenience, not security: caller ID can be faked.
   * Defaults to the opted-in numbers. "*" lets anyone through (judges on their own phones).
   */
  allowedCallers: (process.env.VOICE_ALLOWED_CALLERS || process.env.VOICE_OPTED_IN_NUMBERS || process.env.DEMO_USER_PHONE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Set VOICE_OUTBOUND=off to stop the call_requests poller (for example while testing inbound only). */
  outboundEnabled: (process.env.VOICE_OUTBOUND || "on") !== "off",
  timezone: process.env.DEMO_TIMEZONE || "America/Chicago",
};
