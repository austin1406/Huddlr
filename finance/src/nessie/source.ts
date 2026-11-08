import type { AccountId } from "../../../contracts/src";
import { NessieClient, type NessieAccount, type NessieItem } from "./client";

export type SourceKind = "purchase" | "deposit" | "withdrawal" | "transfer" | "bill";

/** One record from the transaction log, in the engine's terms. */
export interface SourceTxn {
  id: string;
  kind: SourceKind;
  /** The account the record sits on (for a transfer, the sender). */
  account: AccountId;
  amount: number;
  /** Local calendar day the record carries, if any. */
  date: string | null;
  description: string;
  /** Bills only. */
  nickname?: string;
  status?: string;
}

/**
 * The finance engine keeps its own ledger and balances. A source supplies the transaction log: everything
 * it holds at first sight is history, and records that appear later are new.
 */
export interface TxnSource {
  readonly name: string;
  fetchAll(): Promise<SourceTxn[]>;
  recordPurchase(input: { account: "checking" | "card"; amount: number; merchant: string; category: string; date: string }): Promise<string>;
  recordDeposit(input: { amount: number; description: string; date: string }): Promise<string>;
  recordTransfer(input: { from: AccountId; to: AccountId; amount: number; date: string }): Promise<string>;
  recordBill(input: { label: string; amount: number; dueDate: string }): Promise<string>;
}

const TYPE_TO_ACCOUNT: Record<string, AccountId> = { Checking: "checking", Savings: "savings", "Credit Card": "card" };

/** Nessie stores whole dollars (it truncates), so amounts are rounded before they are sent. See docs/nessie.md. */
const dollars = (n: number) => Math.round(n);

const itemId = (i: NessieItem): string => i._id ?? i.id ?? "";

export interface NessieInfo {
  customerId: string;
  accounts: Partial<Record<AccountId, { id: string; balance: number }>>;
}

export class NessieSource implements TxnSource {
  readonly name = "nessie";
  private merchantIds = new Map<string, string>();

  private constructor(
    private readonly client: NessieClient,
    readonly info: NessieInfo,
  ) {}

  /** Finds the customer by name and maps their accounts by type. Throws if the customer or a checking account is missing. */
  static async connect(client: NessieClient, customer: { firstName: string; lastName: string }): Promise<NessieSource> {
    const all = await client.customers();
    const found = all.find((c) => c.first_name === customer.firstName && c.last_name === customer.lastName);
    if (!found) throw new Error(`Nessie has no customer named ${customer.firstName} ${customer.lastName}. Run the seed script first.`);
    const accounts = await client.customerAccounts(found._id);
    const mapped: NessieInfo["accounts"] = {};
    for (const a of accounts as NessieAccount[]) {
      const id = TYPE_TO_ACCOUNT[a.type];
      if (id && !mapped[id]) mapped[id] = { id: a._id, balance: a.balance };
    }
    if (!mapped.checking) throw new Error(`${customer.firstName} ${customer.lastName} has no Checking account in Nessie.`);
    return new NessieSource(client, { customerId: found._id, accounts: mapped });
  }

  /** Every purchase, deposit, withdrawal, transfer and bill on the mapped accounts. */
  async fetchAll(): Promise<SourceTxn[]> {
    const out: SourceTxn[] = [];
    const jobs = Object.entries(this.info.accounts).map(async ([account, { id }]) => {
      const acct = account as AccountId;
      const [purchases, deposits, withdrawals, transfers, bills] = await Promise.all([
        this.client.purchases(id),
        this.client.deposits(id),
        this.client.withdrawals(id),
        this.client.transfers(id),
        acct === "checking" ? this.client.bills(id) : Promise.resolve([] as NessieItem[]),
      ]);
      const add = (kind: SourceKind, i: NessieItem, amount: number | undefined, date: string | undefined) => {
        const sid = itemId(i);
        if (!sid) return;
        out.push({ id: sid, kind, account: acct, amount: amount ?? 0, date: date ?? null, description: i.description ?? i.payee ?? "", nickname: i.nickname, status: i.status });
      };
      for (const i of purchases) add("purchase", i, i.amount, i.purchase_date);
      for (const i of deposits) add("deposit", i, i.amount, i.transaction_date);
      for (const i of withdrawals) add("withdrawal", i, i.amount, i.transaction_date);
      for (const i of transfers) add("transfer", i, i.amount, i.transaction_date);
      for (const i of bills) add("bill", i, i.payment_amount, i.payment_date);
    });
    await Promise.all(jobs);
    return out;
  }

  private account(id: AccountId): string {
    const a = this.info.accounts[id];
    if (!a) throw new Error(`Nessie has no ${id} account for this customer`);
    return a.id;
  }

  private async merchantId(name: string, category: string): Promise<string> {
    const cached = this.merchantIds.get(name);
    if (cached) return cached;
    for (const m of await this.client.merchants()) this.merchantIds.set(m.name, m._id);
    const known = this.merchantIds.get(name);
    if (known) return known;
    const created = await this.client.create("/merchants", { name, category });
    this.merchantIds.set(name, created);
    return created;
  }

  async recordPurchase(input: { account: "checking" | "card"; amount: number; merchant: string; category: string; date: string }): Promise<string> {
    const merchant_id = await this.merchantId(input.merchant, input.category);
    // `status` is mandatory: a purchase without it breaks the account's purchase list for good.
    return this.client.create(`/accounts/${this.account(input.account)}/purchases`, {
      merchant_id, medium: "balance", purchase_date: input.date, amount: dollars(input.amount), status: "completed", description: input.merchant,
    });
  }

  recordDeposit(input: { amount: number; description: string; date: string }): Promise<string> {
    return this.client.create(`/accounts/${this.account("checking")}/deposits`, {
      medium: "balance", transaction_date: input.date, status: "completed", amount: dollars(input.amount), description: input.description,
    });
  }

  /** Nessie cannot store a destination, so the route goes in the description ("savings->checking"). */
  recordTransfer(input: { from: AccountId; to: AccountId; amount: number; date: string }): Promise<string> {
    return this.client.create(`/accounts/${this.account(input.from)}/transfers`, {
      transaction_date: input.date, status: "completed", amount: dollars(input.amount), description: `${input.from}->${input.to}`,
    });
  }

  /** `payment_date` and `recurring_date` are both mandatory: a bill missing either breaks the account's bill list. */
  recordBill(input: { label: string; amount: number; dueDate: string }): Promise<string> {
    return this.client.create(`/accounts/${this.account("checking")}/bills`, {
      status: "pending", payee: input.label, nickname: "oneoff", payment_date: input.dueDate, recurring_date: Number(input.dueDate.slice(8, 10)), payment_amount: dollars(input.amount),
    });
  }
}
