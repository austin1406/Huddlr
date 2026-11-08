// reset-agents: clears P2's tables through the running service, so a demo starts clean.
//   npm run reset                       uses AGENTS_URL, else PUBLIC_BASE_URL, else http://localhost:5000
//   AGENTS_URL=http://localhost:5055 npm run reset     (local mode)
// The next event poll after a reset skips the finance backlog, so old events are not replayed.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { AGENT_ENDPOINTS, AGENTS_BASE_PATH, TOOL_AUTH_HEADER } from "../../contracts/src";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const base = (process.env.AGENTS_URL || process.env.PUBLIC_BASE_URL || "http://localhost:5000").replace(/\/$/, "");
const secret = process.env.HUDDLR_SECRET || "";
const started = Date.now();
const res = await fetch(`${base}${AGENTS_BASE_PATH}${AGENT_ENDPOINTS.reset.path}`, {
  method: "POST",
  headers: secret ? { [TOOL_AUTH_HEADER]: secret } : {},
  signal: AbortSignal.timeout(10_000),
}).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }));
const body = await res.text();
console.log(`${res.ok ? "reset ok" : "reset FAILED"} (${res.status}) in ${Date.now() - started} ms: ${body.slice(0, 200)}`);
process.exit(res.ok ? 0 : 1);
