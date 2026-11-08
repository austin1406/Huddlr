// End-to-end on an in-memory Postgres: HTTP endpoints as P1/P4 call them, and text replies as P3 delivers them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Plan, ProposalSummary, TOOL_AUTH_HEADER } from "../../contracts/src";
import { createApp } from "../src/app";
import { migrate } from "../src/db";
import { makeProposalService } from "../src/proposals";
import { handleInbound } from "../src/replies";

const plan = Plan.parse(JSON.parse(readFileSync(new URL("../../contracts/fixtures/plan.fixture.json", import.meta.url), "utf8")));
const PHONE = "+12145550123";
const SECRET = "test-secret";

async function setup() {
  const db = new PGlite();
  await migrate(db);
  let t = new Date("2026-12-02T15:00:00.000Z").getTime();
  const now = () => new Date(t);
  const proposals = makeProposalService(db, now);
  const app = createApp({ db, proposals, secret: SECRET, demoUserPhone: PHONE });
  const call = (method: string, path: string, body?: unknown, secret: string | null = SECRET) =>
    app.request(`/agents${path}`, {
      method,
      headers: { "content-type": "application/json", ...(secret ? { [TOOL_AUTH_HEADER]: secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let inboundId = 0;
  /** Simulates P3's webhook writing a text, then the agents handling it. */
  const text = async (body: string) => {
    inboundId++;
    await db.query(
      "INSERT INTO inbound_messages (provider_msg_id, user_phone, text, received_sim_at) VALUES ($1, $2, $3, $4)",
      [`photon-${inboundId}`, PHONE, body, now()],
    );
    return handleInbound(db, proposals, { id: inboundId, user_phone: PHONE, text: body }, now());
  };
  const outbox = async () =>
    (await db.query<{ speaker: string; text: string; priority: number; reply_to: number }>("SELECT speaker, text, priority, reply_to FROM outbox ORDER BY id")).rows;
  const createProposal = async () =>
    (await (await call("POST", "/proposals", { plan, from: "savings", to: "checking", amount: 143, actionText: "Move $143 from Savings to Checking" })).json()) as { proposal: ProposalSummary };
  return { db, call, text, outbox, createProposal, jump: (ms: number) => { t += ms; } };
}

test("health is open; everything else needs the shared secret", async () => {
  const { call } = await setup();
  assert.equal((await call("GET", "/health", undefined, null)).status, 200);
  assert.equal((await call("GET", "/proposals/pending", undefined, null)).status, 401);
  assert.equal((await call("GET", "/proposals/pending", undefined, "wrong")).status, 401);
  assert.equal((await call("GET", "/proposals/pending")).status, 200);
});

test("HTTP flow: create, pending, accept (voice), duplicate accept is 409, complete", async () => {
  const { call, createProposal } = await setup();
  const { proposal } = await createProposal();
  const pending = (await (await call("GET", "/proposals/pending")).json()) as { proposal: ProposalSummary };
  assert.equal(ProposalSummary.parse(pending.proposal).id, proposal.id);

  const accept = await call("POST", `/proposals/${proposal.id}/accept`, { via: "voice" });
  assert.equal(accept.status, 200);
  const dup = await call("POST", `/proposals/${proposal.id}/accept`, { via: "text" });
  assert.equal(dup.status, 409);
  assert.equal(((await dup.json()) as { reason: string }).reason, "already_accepted");

  const done = await call("POST", `/proposals/${proposal.id}/complete`, { txnId: "nessie-xfer-9" });
  assert.equal(((await done.json()) as { status: string }).status, "completed");
});

test("HTTP: bad input is 400, unknown id is 404", async () => {
  const { call } = await setup();
  assert.equal((await call("POST", "/proposals/1/accept", { via: "fax" })).status, 400);
  assert.equal((await call("POST", "/proposals", { amount: -5 })).status, 400);
  assert.equal((await call("POST", "/proposals/999/accept", { via: "text" })).status, 404);
});

test("text YES accepts and the Coach confirms once; a second YES sends nothing", async () => {
  const { text, outbox, createProposal } = await setup();
  await createProposal();
  assert.equal((await text("YES")).kind, "accepted");
  assert.equal((await text("yes!!")).kind, "chat"); // nothing pending anymore
  const sent = await outbox();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].speaker, "coach");
  assert.match(sent[0].text, /Move \$143 from Savings to Checking/);
  assert.match(sent[0].text, /bank app/, "the user moves the money, not the agent");
  assert.equal(sent[0].priority, 1);
});

test("unclear short reply asks for a clear YES and does not accept", async () => {
  const { text, outbox, createProposal, call } = await setup();
  await createProposal();
  assert.equal((await text("maybe?")).kind, "clarify");
  assert.match((await outbox())[0].text, /clear YES/);
  const still = (await (await call("GET", "/proposals/pending")).json()) as { proposal: ProposalSummary | null };
  assert.equal(still.proposal?.status, "pending");
});

test("with a plan waiting, an @-mention or a short question still reaches the characters (never approves)", async () => {
  const { text, createProposal, call } = await setup();
  await createProposal();
  for (const t of ["@savings how am i doing", "@Savings", "​@Savings hi", "how's my card?", "what about IRA", "why?", "can I do half"])
    assert.equal((await text(t)).kind, "chat", t);
  for (const t of ["maybe", "ok wait", "yes but only $50", "hmm?"]) assert.equal((await text(t)).kind, "clarify", t);
  const still = (await (await call("GET", "/proposals/pending")).json()) as { proposal: ProposalSummary | null };
  assert.equal(still.proposal?.status, "pending", "nothing above approved the plan");
});

test("NO declines; a long unrelated message is left for the characters", async () => {
  const { text, createProposal } = await setup();
  await createProposal();
  assert.equal((await text("how much is on my credit card right now anyway")).kind, "chat");
  assert.equal((await text("nah")).kind, "declined");
});

test("a YES after the 2-hour window is refused and explained", async () => {
  const { text, outbox, createProposal, jump } = await setup();
  await createProposal();
  jump(2 * 3600_000 + 1);
  assert.equal((await text("yes")).kind, "expired");
  const sent = await outbox();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /expired/);
  assert.equal((await text("yes")).kind, "expired", "each late YES gets an answer, keyed to its own message");
});

test("the same inbound row is never handled twice", async () => {
  const { db, text } = await setup();
  await text("hello");
  const again = await handleInbound(db, makeProposalService(db, () => new Date()), { id: 1, user_phone: PHONE, text: "hello" }, new Date());
  assert.equal(again.kind, "duplicate");
});

test("reset clears P2's tables", async () => {
  const { call, createProposal, outbox, text } = await setup();
  await createProposal();
  await text("yes");
  assert.equal((await call("POST", "/reset")).status, 200);
  assert.equal((await outbox()).length, 0);
  const p = (await (await call("GET", "/proposals/pending")).json()) as { proposal: unknown };
  assert.equal(p.proposal, null);
});
