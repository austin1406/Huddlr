/**
 * Accounts the user adds themselves on the Huddle page ("+ Add account"), for money the bank data doesn't cover.
 *
 * Each type always goes to the same existing agent, by what the money is for, so no new agents are needed:
 *   spend now → Checking · set aside → Savings · long-term → IRA · revolving credit → Card · set payments → Loan.
 *
 * Stored in P2's memory_facts so the agents can read them too:
 *   - loans (student, auto, personal) as  loan:<name>    {label, owed, aprPercent?, monthlyPayment?}  (same shape P2 uses
 *     for loans told by text, so the Loan agent already knows them) and they join the one Loan seat;
 *   - everything else as                  account:<id>   {type, name, balance, owner, group, ...}     with its own seat.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "./state.js";

export type Owner = "checking" | "savings" | "ira" | "card" | "car_loan";
type Field = "rate" | "monthly" | "until";
export type AccountType = { label: string; emoji: string; group: "have" | "owe"; owner: Owner; fields: Field[]; joinsLoan?: true };

export const ACCOUNT_TYPES: Record<string, AccountType> = {
  checking: { label: "Another checking account", emoji: "🏦", group: "have", owner: "checking", fields: [] },
  cash_app: { label: "Cash app (Venmo, PayPal, Cash App)", emoji: "📲", group: "have", owner: "checking", fields: [] },
  savings: { label: "Another savings account", emoji: "🐷", group: "have", owner: "savings", fields: ["rate"] },
  cd: { label: "CD (certificate of deposit)", emoji: "🔒", group: "have", owner: "savings", fields: ["rate", "until"] },
  money_market: { label: "Money market", emoji: "🪙", group: "have", owner: "savings", fields: ["rate"] },
  hsa: { label: "HSA (health savings)", emoji: "🩺", group: "have", owner: "savings", fields: [] },
  retirement_401k: { label: "401(k)", emoji: "🏛️", group: "have", owner: "ira", fields: [] },
  roth_ira: { label: "Roth IRA", emoji: "🌿", group: "have", owner: "ira", fields: [] },
  brokerage: { label: "Investments (brokerage)", emoji: "📈", group: "have", owner: "ira", fields: [] },
  crypto: { label: "Crypto", emoji: "🔷", group: "have", owner: "ira", fields: [] },
  other_have: { label: "Other money I have", emoji: "💼", group: "have", owner: "savings", fields: [] },
  credit_card: { label: "Another credit card", emoji: "💳", group: "owe", owner: "card", fields: ["rate", "monthly"] },
  store_card: { label: "Store card", emoji: "🛍️", group: "owe", owner: "card", fields: ["rate", "monthly"] },
  bnpl: { label: "Buy now, pay later", emoji: "🗓️", group: "owe", owner: "card", fields: ["monthly"] },
  mortgage: { label: "Mortgage", emoji: "🏠", group: "owe", owner: "car_loan", fields: ["rate", "monthly"] },
  student_loan: { label: "Student loan", emoji: "🎓", group: "owe", owner: "car_loan", fields: ["rate", "monthly"], joinsLoan: true },
  auto_loan: { label: "Auto loan", emoji: "🚗", group: "owe", owner: "car_loan", fields: ["rate", "monthly"], joinsLoan: true },
  personal_loan: { label: "Personal loan", emoji: "🤝", group: "owe", owner: "car_loan", fields: ["rate", "monthly"], joinsLoan: true },
  other_owe: { label: "Other money I owe", emoji: "📄", group: "owe", owner: "car_loan", fields: ["rate", "monthly"] },
};

export const MAX_ADDED = 12;

export type UserAccount = {
  key: string;
  type: string;
  name: string;
  balance: number;
  aprPercent?: number;
  monthlyPayment?: number;
  until?: string;
  owner: Owner;
  group: "have" | "owe";
};

export type AccountInput = { type: string; name: string; balance: number; aprPercent?: number; monthlyPayment?: number; until?: string };

const num = (x: unknown) => (x === "" || x == null ? undefined : Number(String(x).replace(/[$,%\s]/g, "")));

/** Checks what the form sent. Returns the clean input or a plain-English problem. */
export function parseAccount(body: any): AccountInput | { error: string } {
  const t = ACCOUNT_TYPES[body?.type];
  if (!t) return { error: "Pick what kind of account this is." };
  const name = String(body?.name ?? "").replace(/[^\p{L}\p{N} '&().,/-]/gu, "").trim().slice(0, 40) || t.label;
  const balance = num(body?.balance);
  if (balance == null || !Number.isFinite(balance) || balance < 0 || balance > 50_000_000)
    return { error: t.group === "owe" ? "Enter how much you owe." : "Enter how much is in it." };
  const out: AccountInput = { type: body.type, name, balance: Math.round(balance * 100) / 100 };
  const rate = num(body?.aprPercent);
  if (rate != null) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { error: "The interest rate should be between 0 and 100." };
    out.aprPercent = Math.round(rate * 100) / 100;
  }
  const monthly = num(body?.monthlyPayment);
  if (monthly != null) {
    if (!Number.isFinite(monthly) || monthly < 0 || monthly > 1_000_000) return { error: "Check the monthly payment." };
    out.monthlyPayment = Math.round(monthly * 100) / 100;
  }
  if (body?.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.until))) return { error: "Pick the date it unlocks." };
    out.until = String(body.until);
  }
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "account";

async function upsert(db: Db, phone: string, key: string, value: object) {
  await db.query(
    `INSERT INTO memory_facts (user_phone, kind, key, value, source, created_sim_at, updated_sim_at)
     VALUES ($1, 'note', $2, $3, 'text', now(), now())
     ON CONFLICT (user_phone, key) DO UPDATE SET value = EXCLUDED.value, updated_sim_at = now()`,
    [phone, key, JSON.stringify(value)],
  );
}

function valueFor(a: AccountInput) {
  const t = ACCOUNT_TYPES[a.type];
  if (t.joinsLoan) return { label: a.name, owed: a.balance, aprPercent: a.aprPercent, monthlyPayment: a.monthlyPayment, type: a.type, addedVia: "huddle" };
  return { ...a, owner: t.owner, group: t.group, addedVia: "huddle" };
}

export async function countAdded(db: Db, phone: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memory_facts WHERE user_phone = $1 AND (key LIKE 'account:%' OR (key LIKE 'loan:%' AND value->>'addedVia' = 'huddle'))`,
    [phone],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function addAccount(db: Db, phone: string, a: AccountInput): Promise<string> {
  const t = ACCOUNT_TYPES[a.type];
  const key = t.joinsLoan ? `loan:${slug(a.name)}` : `account:${slug(a.type)}_${randomBytes(3).toString("hex")}`;
  await upsert(db, phone, key, valueFor(a));
  return key;
}

/** Edits keep the key (so the agents see one account, changed), except a loan whose name changed. */
export async function updateAccount(db: Db, phone: string, key: string, a: AccountInput): Promise<boolean> {
  if (!/^(account|loan):[a-z0-9_]+$/.test(key)) return false;
  const exists = await db.query(`SELECT 1 FROM memory_facts WHERE user_phone = $1 AND key = $2`, [phone, key]);
  if (!exists.rows.length) return false;
  if (key.startsWith("loan:") !== !!ACCOUNT_TYPES[a.type].joinsLoan) return false; // can't turn a loan into a seat or back
  await upsert(db, phone, key, valueFor(a));
  return true;
}

export async function removeAccount(db: Db, phone: string, key: string): Promise<boolean> {
  if (!/^(account|loan):[a-z0-9_]+$/.test(key)) return false;
  const r = await db.query(`DELETE FROM memory_facts WHERE user_phone = $1 AND key = $2 RETURNING id`, [phone, key]);
  return r.rows.length > 0;
}

export async function loadUserAccounts(db: Db, phone: string): Promise<UserAccount[]> {
  try {
    const r = await db.query<{ key: string; value: any }>(
      `SELECT key, value FROM memory_facts WHERE user_phone = $1 AND key LIKE 'account:%' ORDER BY created_sim_at, id`,
      [phone],
    );
    return r.rows
      .map((x) => ({ key: x.key, ...(typeof x.value === "string" ? JSON.parse(x.value) : x.value) }))
      .filter((v) => ACCOUNT_TYPES[v.type] && typeof v.balance === "number")
      .map((v) => ({ ...v, owner: ACCOUNT_TYPES[v.type].owner, group: ACCOUNT_TYPES[v.type].group }));
  } catch {
    return [];
  }
}
