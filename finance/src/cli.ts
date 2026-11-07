// Demo and test controls for the finance engine. Run from finance/:  npm run <script> -- <args>
// Talks to the running service's /admin routes (localhost by default, since Caddy does not route /admin).
import { TOOL_AUTH_HEADER } from "../../contracts/src";
import { env } from "./env";

const BASE = (process.env.FINANCE_ADMIN_URL || `http://localhost:${env.port}`).replace(/\/$/, "");

const USAGE = `Usage (run from finance/):
  npm run post-purchase -- <amount> [merchant] [--category shopping] [--account checking|card]
  npm run post-transfer -- <from> <to> <amount>          accounts: checking savings card car_loan ira
  npm run post-paycheck -- [amount]                       lands a paycheck now, next one is 14 days later
  npm run post-bill     -- <label> <amount> [--in-days 2 | --date YYYY-MM-DD] [--nonessential]
  npm run jump-days     -- <days>                         fast-forward the simulated clock
  npm run demo-mode     -- on|off
  npm run scenario      -- normal|shortfall               reset, then optionally open the $143 gap
  npm run reset                                           everything back to the start (clock too)
  npm run state                                           balances, clock, recent transactions
Set FINANCE_ADMIN_URL to point at another host.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Splits `--flag value` pairs from positional arguments. */
function parse(args: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else flags[a.slice(2)] = true;
  }
  return { pos, flags };
}

const num = (s: string | undefined, what: string): number => {
  const n = Number(s);
  if (s === undefined || !Number.isFinite(n)) fail(`${what} must be a number\n\n${USAGE}`);
  return n;
};

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(env.huddlrSecret ? { [TOOL_AUTH_HEADER]: env.huddlrSecret } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return fail(`Could not reach the finance service at ${BASE} (${(err as Error).message}). Is it running?`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) return fail(`HTTP ${res.status} from ${path}: ${JSON.stringify(json)}`);
  return json;
}

const [command, ...rest] = process.argv.slice(2);
const { pos, flags } = parse(rest);

switch (command) {
  case "post-purchase": {
    const result = await call("POST", "/admin/purchase", {
      amount: num(pos[0], "amount"),
      ...(pos[1] ? { merchant: pos.slice(1).join(" ") } : {}),
      ...(typeof flags.category === "string" ? { category: flags.category } : {}),
      ...(typeof flags.account === "string" ? { account: flags.account } : {}),
    });
    console.log(JSON.stringify(result));
    break;
  }
  case "post-transfer": {
    if (!pos[0] || !pos[1]) fail(USAGE);
    console.log(JSON.stringify(await call("POST", "/admin/transfer", { from: pos[0], to: pos[1], amount: num(pos[2], "amount") })));
    break;
  }
  case "post-paycheck":
    console.log(JSON.stringify(await call("POST", "/admin/paycheck", pos[0] ? { amount: num(pos[0], "amount") } : {})));
    break;
  case "post-bill": {
    if (!pos[0]) fail(USAGE);
    const amountIndex = pos.findIndex((p, i) => i > 0 && Number.isFinite(Number(p)));
    if (amountIndex < 1) fail(`amount must be a number\n\n${USAGE}`);
    console.log(
      JSON.stringify(
        await call("POST", "/admin/bill", {
          label: pos.slice(0, amountIndex).join(" "),
          amount: Number(pos[amountIndex]),
          ...(typeof flags.date === "string" ? { dueDate: flags.date } : {}),
          ...(typeof flags["in-days"] === "string" ? { dueInDays: Number(flags["in-days"]) } : {}),
          ...(flags.nonessential ? { essential: false } : {}),
        }),
      ),
    );
    break;
  }
  case "jump-days": {
    const r = (await call("POST", "/admin/sim/jump-days", { days: num(pos[0], "days") })) as { state: { today: string; now: string } };
    console.log(`Simulated date is now ${r.state.today} (${r.state.now})`);
    break;
  }
  case "demo-mode": {
    if (pos[0] !== "on" && pos[0] !== "off") fail(USAGE);
    console.log(JSON.stringify(await call("POST", "/admin/sim/demo-mode", { on: pos[0] === "on" })));
    break;
  }
  case "scenario": {
    if (pos[0] !== "normal" && pos[0] !== "shortfall") fail(USAGE);
    console.log(JSON.stringify(await call("POST", "/admin/scenario", { scenario: pos[0] })));
    break;
  }
  case "reset":
    console.log(JSON.stringify(await call("POST", "/admin/reset")));
    break;
  case "state":
    console.log(JSON.stringify(await call("GET", "/admin/state"), null, 2));
    break;
  default:
    fail(USAGE);
}
