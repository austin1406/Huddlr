import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySimStateStore } from "../../contracts/src";
import { PERSONA } from "../src/data/config";
import { EngineBackend, SOURCE_POLL_MS } from "../src/engine/backend";
import { NessieClient, NessieError } from "../src/nessie/client";
import { NessieSource } from "../src/nessie/source";
import { NoProposals } from "../src/proposals";
import { FakeNessie } from "./helpers/fakeNessie";

const T0 = Date.parse("2026-11-07T16:00:00.000Z"); // 10:00 in Chicago
const MAYA = { firstName: "Maya", lastName: "Rivera" };

const newStore = () => new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: new Date(T0).toISOString() });

async function setup() {
  const nessie = new FakeNessie();
  const ids = nessie.seedMaya();
  const source = await NessieSource.connect(new NessieClient("https://nessie.test", "test-key", { fetchImpl: nessie.fetch }), MAYA);
  const clock = { now: T0 };
  const backend = await EngineBackend.create({ persona: PERSONA, store: newStore(), gateway: new NoProposals(), realNow: () => clock.now, source });
  /** Move past the poll interval so the next read looks at Nessie again. */
  const later = (ms = SOURCE_POLL_MS + 1000) => void (clock.now += ms);
  return { nessie, ids, source, backend, clock, later };
}

async function personaOnly() {
  return EngineBackend.create({ persona: PERSONA, store: newStore(), gateway: new NoProposals(), realNow: () => T0 });
}

const types = async (b: EngineBackend) => (await b.listEvents()).map((e) => e.type);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

test("connect finds the customer and maps accounts by type; a missing customer is a clear error", async () => {
  const { source, ids } = await setup();
  assert.equal(source.info.accounts.checking?.id, ids.checking);
  assert.equal(source.info.accounts.savings?.id, ids.savings);
  assert.equal(source.info.accounts.card?.id, ids.card);
  const empty = new FakeNessie();
  await assert.rejects(NessieSource.connect(new NessieClient("https://nessie.test", "test-key", { fetchImpl: empty.fetch }), MAYA), /no customer named Maya Rivera/);
});

test("errors never contain the API key", async () => {
  const nessie = new FakeNessie("the-real-key");
  const client = new NessieClient("https://nessie.test", "SUPER-SECRET-KEY", { fetchImpl: nessie.fetch });
  const err = await client.customers().then(() => null, (e: unknown) => e as NessieError);
  assert.ok(err instanceof NessieError);
  assert.equal(err.status, 403);
  assert.ok(!err.message.includes("SUPER-SECRET-KEY"));
});

test("golden: facts built on top of the seeded Nessie history equal the persona-only facts", async () => {
  const { backend, nessie } = await setup();
  const persona = await personaOnly();
  assert.deepEqual(await backend.facts(), await persona.facts());
  assert.deepEqual(await types(backend), await types(persona)); // history raises no events
  assert.equal((await backend.engine.state()).txnCount, 0); // and applies nothing
  assert.ok(nessie.calls.some((c) => c.includes("/purchases")));
});

test("golden: the seeded history averages the persona's daily spend", async () => {
  const { source } = await setup();
  const purchases = (await source.fetchAll()).filter((t) => t.kind === "purchase");
  assert.equal(purchases.length, 54);
  const total = purchases.reduce((s, t) => s + t.amount, 0);
  assert.equal(total, 2280);
  assert.equal(total / 60, PERSONA.spending.averageDailyDiscretionary);
});

test("golden: a purchase that appears in Nessie gives the same facts as the same purchase posted locally", async () => {
  const { backend, nessie, ids, later } = await setup();
  const id = nessie.addPurchase(ids.card, 142, "Target");
  later();
  const viaNessie = await backend.facts();

  const local = await personaOnly();
  await local.engine.purchase({ amount: 142, account: "card", merchant: "Target" });
  const viaLocal = await local.facts();

  assert.deepEqual(viaNessie.accounts, viaLocal.accounts);
  assert.deepEqual(viaNessie.indicators, viaLocal.indicators);
  assert.deepEqual(viaNessie.forecast, viaLocal.forecast);
  const big = (await backend.listEvents()).find((e) => e.type === "big_purchase");
  assert.equal(big?.id, `evt_big_purchase_nessie-${id}`); // the event id comes from the Nessie record
  assert.deepEqual(big?.data, { merchant: "Target", amount: 142, category: "other" });
});

test("polling is throttled, and a record is applied exactly once", async () => {
  const { backend, nessie, ids, later } = await setup();
  const reads = () => nessie.calls.filter((c) => c === `GET /accounts/${ids.checking}/purchases`).length;
  const base = reads();
  nessie.addPurchase(ids.checking, 90, "Best Buy");
  await backend.facts();
  await backend.facts();
  assert.equal(reads(), base); // inside the interval: no new read, so nothing applied yet
  assert.equal((await backend.facts()).accounts[0]!.balance, 1186.5);

  later();
  assert.equal((await backend.facts()).accounts[0]!.balance, 1096.5);
  assert.equal(reads(), base + 1);
  later();
  await backend.facts();
  assert.equal((await backend.facts()).accounts[0]!.balance, 1096.5); // seen again, not applied again
  assert.equal((await types(backend)).filter((t) => t === "big_purchase").length, 1);
});

test("a purchase made through the engine is written to Nessie as whole dollars with a status, and not applied twice", async () => {
  const { backend, nessie, ids, later } = await setup();
  const txn = await backend.engine.purchase({ amount: 142.37, merchant: "Target", category: "shopping" });
  assert.match(txn.id, /^nessie-purchase-/);

  const stored = nessie.purchases.at(-1)!;
  assert.deepEqual([stored.amount, stored.status, stored.payer_id, stored.purchase_date], [142, "completed", ids.checking, "2026-11-07"]);
  assert.equal((await backend.facts()).accounts[0]!.balance, 1044.13); // the ledger keeps the exact cents

  later();
  assert.equal((await backend.facts()).accounts[0]!.balance, 1044.13);
  assert.equal((await types(backend)).filter((t) => t === "big_purchase").length, 1);
});

test("a new merchant is created in Nessie once", async () => {
  const { backend, nessie } = await setup();
  await backend.engine.purchase({ amount: 100, merchant: "Apple Store" });
  await backend.engine.purchase({ amount: 100, merchant: "Apple Store" });
  assert.equal(nessie.merchants.filter((m) => m.name === "Apple Store").length, 1);
});

test("transfers, paychecks and bills made through the engine reach Nessie in the form the API accepts", async () => {
  const { backend, nessie, source, later } = await setup();
  await backend.engine.transfer("savings", "checking", 143);
  assert.equal(nessie.transfers.at(-1)!.description, "savings->checking"); // the only place Nessie can keep the destination
  await backend.engine.paycheck();
  assert.equal(nessie.deposits.at(-1)!.description, "Paycheck");
  await backend.engine.bill({ label: "Vet", amount: 220.4, dueInDays: 1 });
  assert.deepEqual([nessie.bills.at(-1)!.payment_date, nessie.bills.at(-1)!.payment_amount, nessie.bills.at(-1)!.recurring_date], ["2026-11-08", 220, 8]);

  // the account's bill list must still read (a bill missing a date field would break it for good)
  assert.equal((await nessie.fetch(`https://nessie.test/accounts/${source.info.accounts.checking!.id}/bills?key=test-key`)).status, 200);
  const before = await backend.engine.state();
  later();
  const after = await backend.engine.state();
  assert.deepEqual(after.balances, before.balances); // none of it was applied a second time
  assert.equal(after.unpaidOneOffBills.length, 1);
});

test("things done in Nessie directly: paycheck, gift, transfer, new bill", async () => {
  const { backend, nessie, ids, later } = await setup();
  nessie.deposits.push({ _id: "d-pay", account_id: ids.checking, medium: "balance", transaction_date: "2026-11-07", status: "completed", amount: 1650, description: "Paycheck" });
  nessie.deposits.push({ _id: "d-gift", account_id: ids.checking, medium: "balance", transaction_date: "2026-11-07", status: "completed", amount: 50, description: "Birthday gift" });
  nessie.transfers.push({ _id: "t-1", account_id: ids.savings, transaction_date: "2026-11-07", status: "completed", amount: 143, description: "savings->checking" });
  nessie.bills.push({ _id: "b-new", account_id: ids.checking, status: "pending", payee: "Dentist", nickname: "dentist", payment_date: "2026-11-09", payment_amount: 180 });
  nessie.bills.push({ _id: "b-rent", account_id: ids.checking, status: "recurring", payee: "Rent", nickname: "rent", payment_date: "2027-01-01", payment_amount: 1100 });
  later();

  const state = await backend.engine.state();
  assert.equal(state.balances.checking, 1186.5 + 1650 + 50 + 143);
  assert.equal(state.balances.savings, 900 - 143);
  assert.deepEqual(state.unpaidOneOffBills.map((b) => b.label), ["Dentist"]); // the persona's own bills are not duplicated
  const kinds = await types(backend);
  assert.ok(kinds.includes("paycheck_landed") && kinds.includes("user_transfer_seen"));
  assert.equal(kinds.filter((k) => k === "paycheck_landed").length, 1); // the gift is not a paycheck
});

test("an unreachable Nessie never stops the engine, and nothing is lost when it comes back", async () => {
  const { backend, nessie, ids, later } = await setup();
  nessie.down = true;
  await quiet(async () => {
    later();
    const facts = await backend.facts(); // the poll fails; the engine still answers
    assert.equal(facts.accounts[0]!.balance, 1186.5);
    assert.match(String((await backend.health()).sourceError), /unreachable|fetch failed/);
    const txn = await backend.engine.purchase({ amount: 80, merchant: "Target" }); // written locally only
    assert.match(txn.id, /^sim-purchase-/);
  });

  nessie.down = false;
  nessie.addPurchase(ids.card, 120, "Costco");
  later();
  const state = await backend.engine.state();
  assert.equal(state.balances.card, 2520);
  assert.equal(state.balances.checking, 1106.5);
  assert.equal((await backend.health()).sourceError, undefined);
});

test("reset takes the current contents of Nessie as history again, so nothing floods back", async () => {
  const { backend, ids, nessie, later } = await setup();
  await backend.engine.purchase({ amount: 142, merchant: "Target" });
  nessie.addPurchase(ids.card, 120, "Costco");
  later();
  assert.ok((await types(backend)).includes("big_purchase"));

  await backend.reset();
  later();
  assert.ok(!(await types(backend)).includes("big_purchase"));
  assert.equal((await backend.engine.state()).balances.checking, 1186.5);
  assert.equal((await backend.engine.state()).txnCount, 0);
});

test("health says which source the engine is on", async () => {
  const { backend } = await setup();
  assert.equal((await backend.health()).source, "nessie");
  assert.equal((await (await personaOnly()).health()).source, "persona");
});
