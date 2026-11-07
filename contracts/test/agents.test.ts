import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AccountId,
  CallRequestInsert,
  CharacterId,
  FactsSnapshot,
  OutboxInsert,
  Plan,
  ProposalRow,
  ProposalSummary,
  toCallShortfall,
  toProposalSummary,
} from "../src";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel: string): any => JSON.parse(readFileSync(join(root, rel), "utf8"));

const shortfallFacts = FactsSnapshot.parse(load("fixtures/facts.shortfall.fixture.json"));
const plan = Plan.parse(load("fixtures/plan.fixture.json"));
const cast = load("cast.json").characters as Array<{ id: string; account: string | null }>;
const now = "2026-12-02T15:00:00.000Z";

test("cast uses P1's character and account ids", () => {
  assert.deepEqual(cast.map((c) => c.id).sort(), [...CharacterId.options].sort());
  for (const c of cast) if (c.account !== null) AccountId.parse(c.account);
});

test("proposal row converts to P1's ProposalSummary", () => {
  const row = ProposalRow.parse({
    id: 7, user_phone: "+12145550123", plan, from_account: "savings", to_account: "checking",
    amount_cents: 14300, action_text: "Move $143 from Savings to Checking", source_event_id: null,
    status: "pending", channel: null, created_sim_at: now, expires_at: "2026-12-02T17:00:00.000Z",
    decided_sim_at: null, completed_sim_at: null, completed_txn_id: null,
  });
  const summary = ProposalSummary.parse(toProposalSummary(row));
  assert.equal(summary.id, "7");
  assert.equal(summary.amount, 143);
});

test("P1's shortfall maps into a call request", () => {
  assert.ok(shortfallFacts.shortfall);
  const shortfall = toCallShortfall(shortfallFacts.shortfall!);
  assert.equal(shortfall.amount_cents, Math.round(shortfallFacts.shortfall!.amount * 100));
  CallRequestInsert.parse({
    user_phone: "+12145550123", type: "emergency", proposal_id: 7, shortfall, script_hint: null, created_sim_at: now,
  });
});

test("outbox rejects bad speakers and attachments", () => {
  const ok = { idempotency_key: "evt:x:card", user_phone: "+12145550123", speaker: "card", text: "hi", created_sim_at: now };
  assert.equal(OutboxInsert.parse(ok).priority, 0);
  assert.throws(() => OutboxInsert.parse({ ...ok, speaker: "credit_card" }));
  assert.throws(() => OutboxInsert.parse({ ...ok, attachment: "photo" }));
});
