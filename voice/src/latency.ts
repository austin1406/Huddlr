// Measures how long each finance tool takes to answer, the way the voice agent calls it.
//   npm run latency              against FINANCE_URL (or PUBLIC_BASE_URL)
//   npm run latency -- 20 http://localhost:4000
// Tool time is only part of what the caller hears: ElevenLabs adds speech-to-text, the LLM, and
// text-to-speech. Record end-to-end call latency separately in docs/voice.md.
import { ENDPOINTS, TOOL_AUTH_HEADER, type ToolName } from "../../contracts/src/tools";
import { env } from "./env";

/** A valid example body per tool, matching what the agent sends. */
export const SAMPLE_BODIES: Record<ToolName, unknown> = {
  get_snapshot: {},
  can_i_afford: { amount: 40, label: "dinner" },
  what_if: { scenario: { type: "purchase_now", amount: 120, label: "headphones" } },
  get_plan: { amount: 500, source: "bonus" },
  get_pending_proposal: {},
  // A made-up id so the measurement never accepts a real proposal.
  accept_proposal: { proposalId: "latency-check-not-a-proposal", via: "voice" },
};

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

async function timeOnce(base: string, tool: ToolName): Promise<{ ms: number; status: number }> {
  const t0 = performance.now();
  const res = await fetch(`${base}${ENDPOINTS.tools[tool].path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [TOOL_AUTH_HEADER]: env.huddlrSecret },
    body: JSON.stringify(SAMPLE_BODIES[tool]),
  });
  await res.text();
  return { ms: performance.now() - t0, status: res.status };
}

async function main() {
  const runs = Number(process.argv[2] || 10);
  const base = (process.argv[3] || env.financeUrl).replace(/\/$/, "");
  if (!base) {
    console.error("Set FINANCE_URL or PUBLIC_BASE_URL, or pass a URL: npm run latency -- 10 http://localhost:4000");
    process.exit(1);
  }
  console.log(`Timing ${runs} calls per tool against ${base}\n`);
  console.log("tool                   status  median   p95     max");
  let worst = 0;
  for (const tool of Object.keys(SAMPLE_BODIES) as ToolName[]) {
    const times: number[] = [];
    const statuses = new Set<number>();
    for (let i = 0; i < runs; i++) {
      const r = await timeOnce(base, tool);
      times.push(r.ms);
      statuses.add(r.status);
    }
    times.sort((a, b) => a - b);
    const p95 = percentile(times, 95);
    worst = Math.max(worst, p95);
    const fmt = (n: number) => `${n.toFixed(0)}ms`.padEnd(8);
    console.log(`${tool.padEnd(23)}${[...statuses].join(",").padEnd(8)}${fmt(percentile(times, 50))}${fmt(p95)}${fmt(times[times.length - 1])}`);
  }
  console.log(`\nWorst p95: ${worst.toFixed(0)}ms ${worst < 500 ? "(fine for voice)" : "(slow: the caller will hear a pause)"}`);
}

if (process.argv[1]?.endsWith("latency.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
