/**
 * Demo controller: the dashboard's buttons call these, server-side, so the shared secret never
 * reaches the browser and P1's /admin/* stays off the public internet.
 */
export type ControlDeps = {
  financeUrl: string; // http://localhost:4000
  agentsUrl: string; // http://localhost:5000
  secret: string;
  timezone: string; // DEMO_TIMEZONE, for landing fast-forwards on daytime
  fetch?: typeof fetch;
};

export const ACTIONS = ["purchase", "paycheck", "bill", "transfer", "jump", "demo-mode", "scenario", "reset"] as const;
export type Action = (typeof ACTIONS)[number];

const DAY_START = 9; // a fast-forward never lands before 9:00 ...
const DAY_END = 20; // ... or after 20:59 local time, so quiet hours don't silence the demo
const LAND_AT = 10; // when it would, it moves on to 10:00

/** Local hour (0-23) and minute of an instant in a timezone. */
export function localHourMinute(iso: string, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  return { hour: Number(parts.find((p) => p.type === "hour")?.value), minute: Number(parts.find((p) => p.type === "minute")?.value) };
}

/** Extra days to jump so `iso` lands at LAND_AT local time; 0 if it's already daytime. */
export function daytimeNudge(iso: string, timeZone: string): number {
  const { hour, minute } = localHourMinute(iso, timeZone);
  if (hour >= DAY_START && hour <= DAY_END) return 0;
  const nowH = hour + minute / 60;
  const hoursUntil = (LAND_AT - nowH + 24) % 24;
  return hoursUntil / 24;
}

export async function runControl(action: string, body: any, d: ControlDeps): Promise<{ ok: boolean; status: number; result: unknown }> {
  const f = d.fetch ?? fetch;
  const call = async (base: string, path: string, payload?: unknown) => {
    const res = await f(`${base.replace(/\/$/, "")}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(d.secret ? { "x-huddlr-secret": d.secret } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((json as any)?.error ?? `HTTP ${res.status}`), { status: res.status, json });
    return json as any;
  };
  const fin = (path: string, payload?: unknown) => call(d.financeUrl, path, payload);

  try {
    switch (action) {
      case "purchase":
        return ok(await fin("/admin/purchase", pick(body, ["amount", "merchant", "category", "account"])));
      case "paycheck":
        return ok(await fin("/admin/paycheck", pick(body, ["amount"])));
      case "bill":
        return ok(await fin("/admin/bill", pick(body, ["label", "amount", "dueDate", "dueInDays", "essential"])));
      case "transfer":
        return ok(await fin("/admin/transfer", pick(body, ["from", "to", "amount"])));
      case "jump": {
        const first = await fin("/admin/sim/jump-days", { days: Number(body?.days) });
        const extra = daytimeNudge(first.state?.now ?? first.sim?.updatedAt ?? new Date().toISOString(), d.timezone);
        const final = extra > 0 ? await fin("/admin/sim/jump-days", { days: extra }) : first;
        return ok({ now: final.state?.now, landedOnDaytime: extra > 0, extraHours: Math.round(extra * 24 * 10) / 10 });
      }
      case "demo-mode":
        return ok(await fin("/admin/sim/demo-mode", { on: !!body?.on }));
      case "scenario":
        return ok(await fin("/admin/scenario", { scenario: body?.scenario }));
      case "reset": {
        // Finance first (world + clock), then agents (conversation, proposals, outbox).
        // P3's own tables (who has texted, Photon conversation ids) are kept so the demo phone can still be reached.
        const finance = await fin("/admin/reset", {});
        const agents = await call(d.agentsUrl, "/agents/reset", {});
        return ok({ finance, agents });
      }
      default:
        return { ok: false, status: 400, result: { error: `unknown action ${action}` } };
    }
  } catch (err: any) {
    return { ok: false, status: err?.status && err.status < 500 ? err.status : 502, result: err?.json ?? { error: err?.message ?? String(err) } };
  }
}

const ok = (result: unknown) => ({ ok: true, status: 200, result });
function pick(o: any, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== "") out[k] = o[k];
  return out;
}

/** P1's admin state (sim clock, demo mode, balances). Null if finance isn't the engine or is down. */
export async function loadSim(d: ControlDeps): Promise<any | null> {
  try {
    const res = await (d.fetch ?? fetch)(`${d.financeUrl.replace(/\/$/, "")}/admin/state`, {
      headers: d.secret ? { "x-huddlr-secret": d.secret } : {},
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
