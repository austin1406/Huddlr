// Minimal Nessie client. P1 confirms the real base URL and endpoints in docs/nessie.md.

export class Nessie {
  constructor(
    private key: string,
    private base: string,
    private dryRun = false,
  ) {}

  private dryId = 0;

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}${path.includes("?") ? "&" : "?"}key=${this.key}`;
    if (this.dryRun && method !== "GET") {
      console.log(`[dry-run] ${method} ${path}`, body ? JSON.stringify(body) : "");
      return { objectCreated: { _id: `dry-${++this.dryId}` } } as T;
    }
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(path: string, body: unknown): Promise<string> {
    // A purchase without status permanently breaks that account's purchase list (docs/nessie.md).
    if (/\/(purchases|deposits)$/.test(path) && !(body as { status?: string })?.status) {
      throw new Error(`Refusing POST ${path} without status: it would break the account in Nessie`);
    }
    // Same trap for bills: one without payment_date makes the account's bill list return 400.
    if (/\/bills$/.test(path) && !(body as { payment_date?: string })?.payment_date) {
      throw new Error(`Refusing POST ${path} without payment_date: it would break the account's bills in Nessie`);
    }
    const r = await this.req<{ objectCreated?: { _id: string } }>("POST", path, body);
    const id = r.objectCreated?._id;
    if (!id) throw new Error(`POST ${path} returned no id: ${JSON.stringify(r)}`);
    return id;
  }

  get<T>(path: string) {
    return this.req<T>("GET", path);
  }

  // Deletes ALL data of one type for this API key. The key is shared with P1.
  deleteAll(type: "Accounts" | "Bills" | "Customers" | "Deposits" | "Loans" | "Purchases" | "Transfers" | "Withdrawals") {
    return this.req("DELETE", `/data?type=${type}`);
  }
}
