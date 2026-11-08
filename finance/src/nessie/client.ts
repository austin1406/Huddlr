// Thin client for the Nessie API, limited to what the finance engine uses. Behaviour is documented in docs/nessie.md.
// Nessie authenticates with ?key=..., so the key is never put in an error message or log line.

export interface NessieCustomer {
  _id: string;
  first_name?: string;
  last_name?: string;
}

export interface NessieAccount {
  _id: string;
  type: string;
  nickname?: string;
  balance: number;
}

/** A purchase, deposit, withdrawal, transfer or bill as Nessie returns it. Transfer lists use `id`; the rest use `_id`. */
export interface NessieItem {
  _id?: string;
  id?: string;
  amount?: number;
  description?: string;
  status?: string;
  purchase_date?: string;
  transaction_date?: string;
  payment_date?: string;
  payment_amount?: number;
  payee?: string;
  nickname?: string;
  merchant_id?: string;
  payer_id?: string;
}

export class NessieError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class NessieClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(this.key)}`;
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, {
        method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
    } catch (err) {
      throw new NessieError(`${method} ${path} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new NessieError(`${method} ${path} -> ${res.status}: ${typeof json === "string" ? json.slice(0, 200) : JSON.stringify(json).slice(0, 200)}`, res.status);
    }
    return json as T;
  }

  customers(): Promise<NessieCustomer[]> {
    return this.request("GET", "/customers");
  }

  customerAccounts(customerId: string): Promise<NessieAccount[]> {
    return this.request("GET", `/customers/${customerId}/accounts`);
  }

  private async list(kind: "purchases" | "deposits" | "withdrawals" | "transfers" | "bills", accountId: string): Promise<NessieItem[]> {
    // Transfers (and sometimes others) answer 404 when empty.
    const r = await this.request<NessieItem[] | unknown>("GET", `/accounts/${accountId}/${kind}`, undefined, [404]);
    return Array.isArray(r) ? r : [];
  }

  purchases(accountId: string) {
    return this.list("purchases", accountId);
  }
  deposits(accountId: string) {
    return this.list("deposits", accountId);
  }
  withdrawals(accountId: string) {
    return this.list("withdrawals", accountId);
  }
  transfers(accountId: string) {
    return this.list("transfers", accountId);
  }
  bills(accountId: string) {
    return this.list("bills", accountId);
  }

  merchants(): Promise<{ _id: string; name: string }[]> {
    return this.request("GET", "/merchants");
  }

  /** Every create answers { objectCreated: { _id } }. */
  async create(path: string, body: unknown): Promise<string> {
    const r = await this.request<{ objectCreated?: { _id?: string } }>("POST", path, body);
    const id = r?.objectCreated?._id;
    if (!id) throw new NessieError(`POST ${path} returned no id`);
    return id;
  }
}
