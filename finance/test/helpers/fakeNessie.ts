// An in-memory Nessie that behaves the way the real one did in docs/nessie.md (verified 2026-11-08):
// whole dollars only, strict required fields, a purchase without `status` poisons the account's purchase list,
// a bill without `payment_date` poisons the bill list, transfers cannot name a destination, balances never change.

interface Obj {
  _id: string;
  [k: string]: unknown;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AUTH_ERROR = { message: "Missing Authentication Token" };

export class FakeNessie {
  customers: Obj[] = [];
  accounts: Obj[] = [];
  merchants: Obj[] = [];
  purchases: Obj[] = [];
  deposits: Obj[] = [];
  withdrawals: Obj[] = [];
  transfers: Obj[] = [];
  bills: Obj[] = [];
  calls: string[] = [];
  /** When set, every request fails like a dead network. */
  down = false;
  private seq = 0;

  constructor(private readonly key = "test-key") {}

  private id(prefix: string): string {
    return `${prefix}-${String(++this.seq).padStart(4, "0")}`;
  }

  /** Same fields Nessie returns; only whole dollars survive. */
  private whole(n: unknown): number {
    return Math.trunc(Number(n));
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    if (this.down) throw new TypeError("fetch failed");
    if (url.searchParams.get("key") !== this.key) return json(403, AUTH_ERROR);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET") {
      if (parts[0] === "customers" && parts.length === 1) return json(200, this.customers);
      if (parts[0] === "customers" && parts[2] === "accounts") return json(200, this.accounts.filter((a) => a.customer_id === parts[1]));
      if (parts[0] === "merchants") return json(200, this.merchants);
      if (parts[0] === "accounts" && parts[2]) return this.list(parts[1]!, parts[2]);
      return json(403, AUTH_ERROR);
    }

    if (parts[0] === "merchants") {
      if (!body.name) return json(400, "1 validation error for MerchantCreate\nname\n  field required");
      const m: Obj = { ...body, _id: this.id("merchant") };
      this.merchants.push(m);
      return json(201, { code: 201, message: "Merchant created", objectCreated: m });
    }
    if (parts[0] === "accounts" && parts[2]) return this.create(parts[1]!, parts[2], body);
    return json(403, AUTH_ERROR);
  };

  private list(accountId: string, kind: string): Response {
    const own = (rows: Obj[], key: string) => rows.filter((r) => r[key] === accountId);
    if (kind === "purchases") {
      const rows = own(this.purchases, "payer_id");
      if (rows.some((r) => r.status === undefined)) return json(400, "1 validation error for Purchase\nstatus\n  field required (type=value_error.missing)");
      return json(200, rows);
    }
    if (kind === "deposits") return json(200, own(this.deposits, "account_id"));
    if (kind === "withdrawals") return json(200, own(this.withdrawals, "payer_id"));
    if (kind === "transfers") {
      const rows = own(this.transfers, "account_id");
      return rows.length ? json(200, rows.map(({ _id, account_id: _a, ...rest }) => ({ id: _id, ...rest }))) : json(404, "No transfers found for this account");
    }
    if (kind === "bills") {
      const rows = own(this.bills, "account_id");
      if (rows.some((r) => r.payment_date === undefined)) return json(400, "1 validation error for Bill\npayment_date\n  field required (type=value_error.missing)");
      return json(200, rows);
    }
    return json(403, AUTH_ERROR);
  }

  private create(accountId: string, kind: string, b: Record<string, unknown>): Response {
    const missing = (fields: string[]) => fields.filter((f) => b[f] === undefined);
    const bad = (m: string[]) => json(400, `${m.length} validation errors\n${m.map((f) => `${f}\n  field required`).join("\n")}`);
    const done = (rows: Obj[], row: Obj, label: string) => {
      rows.push(row);
      return json(201, { code: 201, message: `${label} created`, objectCreated: row });
    };
    if (kind === "purchases") {
      const m = missing(["merchant_id", "medium", "amount"]);
      if (m.length) return bad(m);
      return done(this.purchases, { ...b, amount: this.whole(b.amount), _id: this.id("purchase"), type: "merchant", payer_id: accountId }, "Purchase");
    }
    if (kind === "deposits") {
      const m = missing(["medium", "transaction_date", "status", "amount", "description"]);
      if (m.length) return bad(m);
      return done(this.deposits, { ...b, amount: this.whole(b.amount), _id: this.id("deposit"), account_id: accountId }, "Deposit");
    }
    if (kind === "withdrawals") {
      const m = missing(["medium", "amount"]);
      if (m.length) return bad(m);
      return done(this.withdrawals, { ...b, amount: this.whole(b.amount), _id: this.id("withdrawal"), payer_id: accountId }, "Withdrawal");
    }
    if (kind === "transfers") {
      const extra = Object.keys(b).filter((k) => !["transaction_date", "status", "amount", "description"].includes(k));
      if (extra.length) return json(400, `${extra.length} validation errors\n${extra.map((k) => `${k}\n  extra fields not permitted`).join("\n")}`);
      const m = missing(["transaction_date", "status", "amount", "description"]);
      if (m.length) return bad(m);
      return done(this.transfers, { ...b, amount: this.whole(b.amount), _id: this.id("transfer"), account_id: accountId }, "Transfer");
    }
    if (kind === "bills") {
      const m = missing(["status", "payee", "payment_amount"]);
      if (m.length) return bad(m);
      return done(this.bills, { ...b, payment_amount: this.whole(b.payment_amount), _id: this.id("bill"), account_id: accountId }, "Bill");
    }
    return json(403, AUTH_ERROR);
  }

  // ---- test setup helpers

  /** A customer with the three accounts Rishi's seed makes. Balances are whole dollars, like the real thing. */
  seedMaya(): { checking: string; savings: string; card: string } {
    const cid = this.id("customer");
    this.customers.push({ _id: cid, first_name: "Maya", last_name: "Rivera" });
    const acct = (type: string, nickname: string, balance: number): string => {
      const _id = this.id("account");
      this.accounts.push({ _id, type, nickname, rewards: 0, balance: this.whole(balance), customer_id: cid });
      return _id;
    };
    const checking = acct("Checking", "Checking", 1186.5);
    const savings = acct("Savings", "Savings", 900);
    const card = acct("Credit Card", "Card", 2400);
    const merchant = this.id("merchant");
    this.merchants.push({ _id: merchant, name: "H-E-B", category: "groceries" });

    // 60 days of history that adds up to $2,280 (38 a day): 18 purchases on checking, 36 on the card.
    const amounts = (n: number, total: number) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
    amounts(18, 489).forEach((amount, i) => this.purchases.push({ _id: this.id("purchase"), merchant_id: merchant, payer_id: checking, purchase_date: `2026-09-${String(14 + (i % 15)).padStart(2, "0")}`, amount, status: "completed", medium: "balance", description: "H-E-B" }));
    amounts(36, 1791).forEach((amount, i) => this.purchases.push({ _id: this.id("purchase"), merchant_id: merchant, payer_id: card, purchase_date: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`, amount, status: "completed", medium: "balance", description: "Shell" }));
    for (const d of ["2026-09-12", "2026-09-26", "2026-10-10", "2026-10-24", "2026-11-07"]) {
      this.deposits.push({ _id: this.id("deposit"), account_id: checking, medium: "balance", transaction_date: d, status: "completed", amount: 1650, description: "Paycheck" });
    }
    const bills: [string, string, number, string, string][] = [
      ["rent", "Rent", 1100, "2026-12-01", "recurring"], ["phone", "Phone", 65, "2026-11-12", "recurring"], ["utilities", "Utilities", 90, "2026-11-18", "recurring"],
      ["streaming", "Streaming", 16, "2026-11-22", "recurring"], ["car_loan", "Car loan payment", 320, "2026-11-25", "recurring"], ["card_minimum", "Card minimum payment", 72, "2026-11-28", "recurring"],
      ["rent", "Rent", 1100, "2026-10-01", "completed"], ["phone", "Phone", 65, "2026-10-12", "completed"],
    ];
    for (const [nickname, payee, amount, date, status] of bills) {
      this.bills.push({ _id: this.id("bill"), account_id: checking, status, payee, nickname, payment_date: date, recurring_date: Number(date.slice(8)), payment_amount: amount });
    }
    return { checking, savings, card };
  }

  /** Something that happens in Nessie outside the engine, such as a teammate adding data by hand. */
  addPurchase(accountId: string, amount: number, merchant: string, date = "2026-11-07"): string {
    const _id = this.id("purchase");
    this.purchases.push({ _id, merchant_id: "m", payer_id: accountId, purchase_date: date, amount: this.whole(amount), status: "completed", medium: "balance", description: merchant });
    return _id;
  }
}
