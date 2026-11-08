// npm run gemini-status: one tiny Gemini call (1 output token) to see whether the key is usable right now.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { config as agentsConfig } from "./character";
import { nextDailyReset, parseQuotaError } from "./quota";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const key = process.env.GEMINI_API_KEY;
const model = process.env.CHARACTER_MODEL || agentsConfig.character_model.model;
if (!key) {
  console.log("No GEMINI_API_KEY in .env");
  process.exit(1);
}
const t = Date.now();
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-goog-api-key": key },
  body: JSON.stringify({ contents: [{ parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 1 } }),
  signal: AbortSignal.timeout(10_000),
});
const ms = Date.now() - t;
const at = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
if (res.ok) {
  console.log(`OK: ${model} answered in ${ms} ms. Exact remaining quota isn't published; see aistudio.google.com -> Rate Limit.`);
} else if (res.status === 429) {
  const e = parseQuotaError(await res.text());
  if (e.scope === "day") console.log(`DAILY LIMIT USED UP. Resets around ${at(nextDailyReset())} your time (midnight Pacific). Characters will use templates until then.`);
  else console.log(`PER-MINUTE LIMIT hit. Try again in ${e.retryAfterSeconds ?? 60} s.`);
  console.log(`  Google says: ${e.message.slice(0, 160)}`);
} else if (res.status === 402) {
  console.log("NO CREDITS: this key's project is on the paid tier with $0 prepaid. Add credits in AI Studio -> Billing, or use a free-tier key.");
} else {
  console.log(`ERROR ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
process.exit(res.ok ? 0 : 1);
