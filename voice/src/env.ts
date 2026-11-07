import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export const env = {
  port: Number(process.env.VOICE_PORT || 8790),
  /** P3's fixed domain. Tool URLs the voice agent calls are built from it. */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  /** Where this service reaches the finance API. Defaults to the public domain. */
  financeUrl: (process.env.FINANCE_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  huddlrSecret: process.env.HUDDLR_SECRET || "",
  demoUserPhone: process.env.DEMO_USER_PHONE || "",
  databaseUrl: process.env.DATABASE_URL || "",
  elevenLabsWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || "",
};
