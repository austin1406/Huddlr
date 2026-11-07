import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// photon/.env (Photon keys) first, then the shared /opt/huddlr/.env (DATABASE_URL etc.).
// dotenv never overwrites a value that is already set, so photon/.env wins on conflicts.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

function required(name: string, ...fallbacks: string[]): string {
  for (const key of [name, ...fallbacks]) {
    const value = process.env[key];
    if (value) return value;
  }
  throw new Error(`Missing ${name} in .env`);
}

export const env = {
  port: Number(process.env.PHOTON_PORT ?? 3000),
  apiKey: () => required("PHOTON_API_KEY", "PHOTON_PROJECT_SECRET"),
  projectId: () => required("PHOTON_PROJECT_ID"),
  webhookSecret: () => required("PHOTON_WEBHOOK_SECRET"),
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Spike only: auto-reply to every inbound text. Keep OFF once agents are running.
  echo: process.env.PHOTON_ECHO === "1",
  // Set to 0 to stop the outbox sender (e.g. while debugging).
  sender: process.env.PHOTON_SENDER !== "0",
};
