import "dotenv/config";

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
  // Spike only: reply "pong" to every inbound text so we can prove the round trip.
  echo: process.env.PHOTON_ECHO === "1",
};
