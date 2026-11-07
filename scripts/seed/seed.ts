// Seeds the Nessie demo customer from persona.json.
//   npm run seed         create the customer if it does not exist yet (safe to re-run)
//   npm run seed:reset   delete all Nessie data for this key, then seed fresh
//   npm run seed:dry     print every request without sending anything
// History is generated from a fixed random seed, so every run produces the same data.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { Nessie } from "./nessie.js";
import { loadPersona, type Persona } from "./persona.js";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const RESET = args.has("--reset");

const key = process.env.NESSIE_API_KEY ?? "";
const base = process.env.NESSIE_BASE_URL || "http://api.nessieisreal.com";
if (!key && !DRY) {
  console.error("NESSIE_API_KEY is not set in .env");
  process.exit(1);
}

// Small deterministic RNG (mulberry32) so re-runs match.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const money = (n: number) => Math.round(n * 100) / 100;

const ADDRESS = { street_number: "800", street_name: "W Campbell Rd", city: "Richardson", state: "TX", zip: "75080" };

async function findCustomer(api: Nessie, p: Persona): Promise<string | undefined> {
  if (DRY) return undefined;
  const all = await api.get<{ _id: string; first_name: string; last_name: string }[]>("/customers");
  return all.find((c) => c.first_name === p.customer.first_name && c.last_name === p.customer.last_name)?._id;
}

async function main() {
  const p = loadPersona();
  const api = new Nessie(key, base, DRY);
  const rand = rng(20261107);
  const today = new Date(`${p.paycheck.last_date}T12:00:00Z`);
  const start = addDays(today, -p.history_days);

  if (RESET) {
    console.log("Reset: deleting all Nessie data for this key (shared with P1)");
    for (const t of ["Purchases", "Deposits", "Bills", "Transfers", "Accounts", "Customers"] as const) {
      await api.deleteAll(t);
    }
  } else {
    const existing = await findCustomer(api, p);
    if (existing) {
      console.log(`Customer already seeded (${existing}). Use --reset to rebuild.`);
      return;
    }
  }

  const customerId = await api.create("/customers", { ...p.customer, address: ADDRESS });
  const acct = (type: string, nickname: string, balance: number) =>
    api.create(`/customers/${customerId}/accounts`, { type, nickname, rewards: 0, balance: Math.round(balance) });
  const checking = await acct("Checking", "Checking", p.accounts.checking.balance);
  const savings = await acct("Savings", "Savings", p.accounts.savings.balance);
  const card = await acct("Credit Card", "Card", p.accounts.credit_card.balance);

  const merchantIds: string[] = [];
  for (const m of p.merchants) {
    merchantIds.push(
      await api.create("/merchants", { name: m.name, category: m.category, address: ADDRESS, geocode: { lat: 32.98, lng: -96.75 } }),
    );
  }

  const counts = { purchases: 0, deposits: 0, bills: 0, transfers: 0 };

  for (let d = new Date(start); d <= today; d = addDays(d, 1)) {
    const date = day(d);

    // 1-3 everyday purchases, mostly on the card, some on checking.
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const mi = Math.floor(rand() * merchantIds.length);
      const amount = money(p.daily_spend.min + rand() * (p.daily_spend.max - p.daily_spend.min));
      const account = rand() < 0.65 ? card : checking;
      await api.create(`/accounts/${account}/purchases`, {
        merchant_id: merchantIds[mi], medium: "balance", purchase_date: date, amount, description: p.merchants[mi].name,
      });
      counts.purchases++;
    }

    // Paycheck every N days, counted back from last_date.
    const daysBack = Math.round((today.getTime() - d.getTime()) / 86_400_000);
    if (daysBack % p.paycheck.every_days === 0) {
      await api.create(`/accounts/${checking}/deposits`, {
        medium: "balance", transaction_date: date, amount: p.paycheck.amount, description: "Paycheck",
      });
      counts.deposits++;
    }

    // Monthly bills paid from checking on their day.
    for (const b of p.bills) {
      if (d.getUTCDate() === b.day_of_month) {
        await api.create(`/accounts/${checking}/bills`, {
          status: "completed", payee: b.payee, nickname: b.payee, payment_date: date, recurring_date: b.day_of_month, payment_amount: b.amount,
        });
        counts.bills++;
      }
    }

    // P2P transfers (to savings as a stand-in payee, since Nessie needs an account id).
    for (const t of p.p2p) {
      if (t.days_ago === daysBack) {
        await api.create(`/accounts/${checking}/transfers`, {
          medium: "balance", payee_id: savings, amount: t.amount, transaction_date: date, description: `P2P to ${t.payee}`,
        });
        counts.transfers++;
      }
    }
  }

  // Upcoming bills as recurring, so the forecast can see them.
  for (const b of p.bills) {
    await api.create(`/accounts/${checking}/bills`, {
      status: "recurring", payee: b.payee, nickname: b.payee, recurring_date: b.day_of_month, payment_amount: b.amount,
    });
  }

  console.log("Seeded", { customerId, checking, savings, card, merchants: merchantIds.length, ...counts });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
