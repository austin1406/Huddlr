import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { MemorySimStateStore, TOOL_AUTH_HEADER, type ProposalSummary } from "../../contracts/src";
import { PERSONA } from "../src/data/config";
import { EngineBackend } from "../src/engine/backend";
import { HttpProposalGateway, NoProposals, findMatchingProposal, type ProposalGateway } from "../src/proposals";
import type { Queryable } from "../src/sim";

const T0 = Date.parse("2026-11-07T16:00:00.000Z");
const none = new NoProposals();
const base = { pending: () => none.pending(), accept: () => none.accept() };

const proposal = (over: Partial<ProposalSummary> = {}): ProposalSummary => ({
  id: "7", actionText: "Move $143 from Savings to Checking", amount: 143, from: "savings", to: "checking", status: "accepted",
  expiresAt: "2026-11-07T18:00:00.000Z", ...over,
});

/** A gateway that records what the watcher asks of the agents service. */
function fakeGateway(open: () => Promise<ProposalSummary[]>) {
  const completed: [string, string][] = [];
  const gateway: ProposalGateway = {
    ...base,
    open,
    async complete(id, txnId) {
      completed.push([id, txnId]);
      return true;
    },
  };
  return { gateway, completed };
}

async function engine(gateway: ProposalGateway, clock = { now: T0 }) {
  const store = new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: new Date(T0).toISOString() });
  const backend = await EngineBackend.create({ persona: PERSONA, store, gateway, realNow: () => clock.now });
  const transferEvents = async () => (await backend.listEvents()).filter((e) => e.type === "user_transfer_seen");
  return { backend, transferEvents };
}

test("findMatchingProposal needs the same accounts and at least the amount, and takes the newest", () => {
  const t = { from: "savings", to: "checking", amount: 143 } as const;
  assert.equal(findMatchingProposal(t, [proposal()])?.id, "7");
  assert.equal(findMatchingProposal({ ...t, amount: 150 }, [proposal()])?.id, "7");
  assert.equal(findMatchingProposal({ ...t, amount: 100 }, [proposal()]), null);
  assert.equal(findMatchingProposal({ ...t, from: "checking", to: "savings" }, [proposal()]), null);
  assert.equal(findMatchingProposal(t, [proposal({ status: "completed" }), proposal({ status: "declined" })]), null);
  assert.equal(findMatchingProposal(t, [proposal({ id: "3" }), proposal({ id: "9", status: "pending" })])?.id, "9");
});

test("a transfer that fulfils an accepted proposal completes it, once", async () => {
  const { gateway, completed } = fakeGateway(async () => [proposal()]);
  const { backend, transferEvents } = await engine(gateway);
  const txn = await backend.engine.transfer("savings", "checking", 143);
  assert.deepEqual(completed, [["7", txn.id]]);
  const [event] = await transferEvents();
  assert.equal(event?.data.matchedProposalId, "7");
  assert.equal(event?.data.txnId, txn.id);
  await backend.facts();
  await backend.listEvents();
  assert.equal(completed.length, 1); // reading again never repeats the call
});

test("a transfer in the wrong direction, or too small, matches nothing", async () => {
  const { gateway, completed } = fakeGateway(async () => [proposal()]);
  const { backend, transferEvents } = await engine(gateway);
  await backend.engine.transfer("checking", "savings", 143);
  await backend.engine.transfer("savings", "checking", 50);
  assert.deepEqual(completed, []);
  assert.deepEqual((await transferEvents()).map((e) => e.data.matchedProposalId), [null, null]);
});

test("when the agents service is down the transfer is retried later and the event is patched", async () => {
  let up = false;
  const { gateway, completed } = fakeGateway(async () => {
    if (!up) throw new Error("connection refused");
    return [proposal()];
  });
  const clock = { now: T0 };
  const { backend, transferEvents } = await engine(gateway, clock);
  const txn = await backend.engine.transfer("savings", "checking", 143);
  assert.deepEqual(completed, []);
  assert.equal((await transferEvents())[0]?.data.matchedProposalId, null);

  up = true;
  clock.now += 5_000; // too soon to retry
  await backend.listEvents();
  assert.deepEqual(completed, []);

  clock.now += 20_000;
  await backend.listEvents();
  assert.deepEqual(completed, [["7", txn.id]]);
  assert.equal((await transferEvents())[0]?.data.matchedProposalId, "7");
  clock.now += 60_000;
  await backend.listEvents();
  assert.equal(completed.length, 1);
});

test("a proposal that cannot be completed any more (expired or done) leaves the event unmatched", async () => {
  const gateway: ProposalGateway = { ...base, open: async () => [proposal()], complete: async () => false };
  const { backend, transferEvents } = await engine(gateway);
  await backend.engine.transfer("savings", "checking", 143);
  assert.equal((await transferEvents())[0]?.data.matchedProposalId, null);
});

test("HttpProposalGateway reads open proposals from the shared database and completes through the agents API", async () => {
  const seen: { sql: string }[] = [];
  const db: Queryable = {
    async query<R>(sql: string) {
      seen.push({ sql });
      return {
        rows: [
          { id: "7", from_account: "savings", to_account: "checking", amount_cents: "14300", action_text: "Move $143 from Savings to Checking", status: "accepted", expires_at: new Date("2026-11-07T18:00:00.000Z") },
        ] as R[],
      };
    },
  };
  const calls: { path: string; secret: string | undefined; body: unknown }[] = [];
  const agents = new Hono().basePath("/agents");
  agents.post("/proposals/:id/complete", async (c) => {
    calls.push({ path: c.req.path, secret: c.req.header(TOOL_AUTH_HEADER), body: await c.req.json() });
    return c.json({ ok: true, status: "completed", reason: null, proposal: null });
  });
  const fetchImpl = ((url: string, init?: RequestInit) => agents.request(url.replace("http://agents", ""), init)) as typeof fetch;
  const gateway = new HttpProposalGateway("http://agents", "s3cret", { db, fetchImpl });

  assert.deepEqual(await gateway.open(), [proposal()]);
  assert.match(seen[0]!.sql, /FROM proposals WHERE status IN \('pending', 'accepted'\)/);
  assert.equal(await gateway.complete("7", "sim-transfer-0001"), true);
  assert.deepEqual(calls, [{ path: "/agents/proposals/7/complete", secret: "s3cret", body: { txnId: "sim-transfer-0001" } }]);
  assert.equal(await gateway.complete("abc", "x"), false);

  const down = new HttpProposalGateway("http://agents", "s3cret", { fetchImpl: (async () => { throw new Error("refused"); }) as typeof fetch });
  await assert.rejects(down.complete("7", "x")); // unreachable surfaces, so the watcher retries
  assert.deepEqual(await down.open(), []); // no database and no pending proposal
});
