// Polls call_requests on the real clock and places outbound calls one at a time.
import { demoMode, loadGoals, pgCallRequestStore, simNow } from "./db";
import { elevenLabsDialer } from "./dialer";
import { env } from "./env";
import { fetchFacts } from "./finance";
import { pollOnce, sweepStale, type PollDeps } from "./outbound";

const POLL_MS = 3_000;
/** A call with no webhook after this long is treated as unanswered. */
const STALE_MS = 15 * 60_000;

export function startPoller(): () => void {
  const deps: PollDeps = {
    store: pgCallRequestStore(),
    dialer: elevenLabsDialer,
    optedIn: (phone) => env.optedInNumbers.includes(phone),
    loadContext: async (phone) => {
      const [facts, goals] = await Promise.all([fetchFacts(), loadGoals(phone)]);
      return { facts, goals };
    },
    simNow,
    demoMode,
    timezone: env.timezone,
  };

  let running = false;
  let lastSweep = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const msg = await pollOnce(deps);
      if (msg !== "idle") console.log(`[voice] ${msg}`);
      if (Date.now() - lastSweep > 60_000) {
        lastSweep = Date.now();
        const n = await sweepStale(deps, STALE_MS);
        if (n) console.log(`[voice] ${n} stale call(s) marked no_answer, text fallback queued`);
      }
    } catch (e) {
      console.error("[voice] poller error", e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, POLL_MS);
  void tick();
  return () => clearInterval(timer);
}
