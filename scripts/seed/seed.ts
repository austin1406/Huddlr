// Seeds the Nessie demo customer from contracts/persona.json.
//   npm run seed         create the customer if it does not exist yet (safe to re-run)
//   npm run seed:reset   delete all Nessie data for this key, then seed fresh
//   npm run seed:dry     print every request without sending anything
// History comes from a fixed random seed, so every run produces the same data.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { Nessie } from "./nessie";
import { loadPersona, type Persona } from "./persona";

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

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100);

const ADDRESS = { street_number: "800", street_name: "W Campbell Rd", city: "Richardson", state: "TX", zip: "75080" };

export interface PlannedPurchase {
  daysAgo: number;
  merchant: number; // index into seedHints.merchants
  amount: number; // dollars, 2 decimals
  onCard: boolean;
}

/**
 * Builds the discretionary purchase history from seedHints, then scales it so the daily average
 * matches spending.averageDailyDiscretionary exactly (P1's golden test compares against it).
 */
export function planPurchases(p: Persona, rand: () => number): PlannedPurchase[] {
  const days = p.seedHints.historyDays;
  const raw: PlannedPurchase[] = [];
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
    p.seedHints.merchants.forEach((m, merchant) => {
      if (rand() < m.perWeek / 7) {
        const [lo, hi] = m.typicalAmount;
        raw.push({ daysAgo, merchant, amount: lo + rand() * (hi - lo), onCard: rand() < 0.65 });
      }
    });
  }
  const targetCents = cents(p.spending.averageDailyDiscretionary * days);
  const rawTotal = raw.reduce((s, x) => s + x.amount, 0);
  const scale = (targetCents / 100) / rawTotal;
  const out = raw.map((x) => ({ ...x, amount: cents(x.amount * scale) / 100 }));
  // Put any rounding remainder on the last purchase so the total is exact to the cent.
  const diff = targetCents - out.reduce((s, x) => s + cents(x.amount), 0);
  out[out.length - 1].amount = (cents(out[out.length - 1].amount) + diff) / 100;
  return out;
}

async function findCustomer(api: Nessie, p: Persona): Promise<string | undefined> {
  if (DRY) return undefined;
  const all = await api.get<{ _id: string; first_name: string; last_name: string }[]>("/customers");
  return all.find((c) => c.first_name === p.customer.firstName && c.last_name === p.customer.lastName)?._id;
}

async function main() {
  const p = loadPersona();
  const api = new Nessie(key, base, DRY);
  const rand = rng(20261107);
  // "Today" is the real date. TODO: switch to the shared now() helper once contracts merge.
  const today = new Date(`${isoDay(new Date())}T12:00:00Z`);
  const dateFor = (daysAgo: number) => isoDay(new Date(today.getTime() - daysAgo * DAY_MS));
  const days = p.seedHints.historyDays;

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

  const customerId = await api.create("/customers", {
    first_name: p.customer.firstName,
    last_name: p.customer.lastName,
    address: ADDRESS,
  });
  // Balances are sent exactly as in persona.json. If Nessie only accepts integers, P1's spike
  // (docs/nessie.md) will say so and the own-ledger mirror covers the cents.
  const acct = (type: string, nickname: string, balance: number) =>
    api.create(`/customers/${customerId}/accounts`, { type, nickname, rewards: 0, balance });
  const checking = await acct("Checking", "Checking", p.accounts.checking.balance);
  const savings = await acct("Savings", "Savings", p.accounts.savings.balance);
  const card = await acct("Credit Card", "Card", p.accounts.card.balance);

  const merchantIds: string[] = [];
  for (const m of p.seedHints.merchants) {
    merchantIds.push(
      await api.create("/merchants", { name: m.name, category: m.category, address: ADDRESS, geocode: { lat: 32.98, lng: -96.75 } }),
    );
  }

  const purchases = planPurchases(p, rand);
  for (const x of purchases) {
    await api.create(`/accounts/${x.onCard ? card : checking}/purchases`, {
      merchant_id: merchantIds[x.merchant],
      medium: "balance",
      purchase_date: dateFor(x.daysAgo),
      amount: x.amount,
      description: p.seedHints.merchants[x.merchant].name,
    });
  }

  let deposits = 0;
  let bills = 0;
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
    const date = dateFor(daysAgo);

    // Paychecks every everyDays, with the latest one lastPaidDaysAgo days ago.
    if (daysAgo >= p.income.lastPaidDaysAgo && (daysAgo - p.income.lastPaidDaysAgo) % p.income.everyDays === 0) {
      await api.create(`/accounts/${checking}/deposits`, {
        medium: "balance", transaction_date: date, amount: p.income.paycheckAmount, description: "Paycheck",
      });
      deposits++;
    }

    // Past bills, paid from checking on their day of the month.
    const dom = new Date(`${date}T12:00:00Z`).getUTCDate();
    for (const b of p.recurringBills) {
      if (dom === b.dayOfMonth) {
        await api.create(`/accounts/${checking}/bills`, {
          status: "completed", payee: b.label, nickname: b.id, payment_date: date, recurring_date: b.dayOfMonth, payment_amount: b.amount,
        });
        bills++;
      }
    }
  }

  // Upcoming bills as recurring, so the forecast can see them.
  for (const b of p.recurringBills) {
    await api.create(`/accounts/${checking}/bills`, {
      status: "recurring", payee: b.label, nickname: b.id, recurring_date: b.dayOfMonth, payment_amount: b.amount,
    });
  }

  // Peers (Alex owes the user money) live in persona.json for the finance engine. Nessie has no
  // external P2P payee, so nothing is posted for them.

  const total = purchases.reduce((s, x) => s + x.amount, 0);
  console.log("Seeded", {
    customerId, checking, savings, card,
    merchants: merchantIds.length,
    purchases: purchases.length,
    purchaseTotal: Math.round(total * 100) / 100,
    avgPerDay: Math.round((total / days) * 100) / 100,
    deposits, bills,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
