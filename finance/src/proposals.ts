import {
  AGENT_ENDPOINTS,
  AGENTS_BASE_PATH,
  TOOL_AUTH_HEADER,
  type AccountId,
  type AcceptProposalResponse,
  type ProposalSummary,
} from "../../contracts/src";
import type { Queryable } from "./sim";

/**
 * The finance tools get_pending_proposal and accept_proposal are thin wrappers: the agents service owns the
 * proposals table and every rule (duplicates, expiry, "unclear means no"). This is the seam to it.
 * The transfer watcher also needs the proposals that are still open (pending or accepted) and a way to
 * mark one completed; finance never writes the table itself.
 */
export interface ProposalGateway {
  pending(): Promise<ProposalSummary | null>;
  accept(proposalId: string, via: "text" | "voice"): Promise<AcceptProposalResponse>;
  /** Proposals the user could still be acting on: pending or accepted, not yet completed. Throws if it cannot tell. */
  open(): Promise<ProposalSummary[]>;
  /** Tell the agents service the money moved. Returns false if the proposal could not be completed (already done, expired, unknown). */
  complete(proposalId: string, txnId: string): Promise<boolean>;
}

/** No agents service: nothing is ever pending. Used in tests and when AGENTS_URL is not set. */
export class NoProposals implements ProposalGateway {
  async pending(): Promise<ProposalSummary | null> {
    return null;
  }
  async accept(): Promise<AcceptProposalResponse> {
    return { ok: false, status: "declined", reason: "not_found", message: "No such proposal." };
  }
  async open(): Promise<ProposalSummary[]> {
    return [];
  }
  async complete(): Promise<boolean> {
    return false;
  }
}

interface OpenRow {
  id: string | number;
  from_account: AccountId;
  to_account: AccountId;
  amount_cents: string | number;
  action_text: string;
  status: ProposalSummary["status"];
  expires_at: Date | string;
}

export class HttpProposalGateway implements ProposalGateway {
  /**
   * `baseUrl` is the agents service origin, for example http://localhost:5000.
   * `db` (the shared Postgres) lets `open()` see accepted proposals, which the HTTP API does not list.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly opts: { timeoutMs?: number; db?: Queryable; fetchImpl?: typeof fetch } = {},
  ) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(`${this.baseUrl.replace(/\/$/, "")}${AGENTS_BASE_PATH}${path}`, {
      method,
      headers: { ...(this.secret ? { [TOOL_AUTH_HEADER]: this.secret } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2000),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async pending(): Promise<ProposalSummary | null> {
    try {
      const r = await this.call(AGENT_ENDPOINTS.getPending.method, AGENT_ENDPOINTS.getPending.path);
      if (r.status !== 200) return null;
      return ((r.json as { proposal?: ProposalSummary | null } | null)?.proposal ?? null) as ProposalSummary | null;
    } catch (err) {
      console.warn(`[finance] agents service unreachable for pending proposal: ${(err as Error).message}`);
      return null;
    }
  }

  async accept(proposalId: string, via: "text" | "voice"): Promise<AcceptProposalResponse> {
    const id = Number(proposalId);
    if (!Number.isInteger(id) || id < 1) return { ok: false, status: "declined", reason: "not_found", message: "No such proposal." };
    try {
      const path = AGENT_ENDPOINTS.accept.path.replace(":id", String(id));
      const r = await this.call("POST", path, { via });
      const j = r.json as { ok?: boolean; status?: AcceptProposalResponse["status"] | null; reason?: AcceptProposalResponse["reason"]; proposal?: ProposalSummary | null } | null;
      if (!j || typeof j.ok !== "boolean") throw new Error(`unexpected reply (HTTP ${r.status})`);
      return {
        ok: j.ok,
        status: j.status ?? "declined",
        reason: j.reason ?? null,
        message: j.ok && j.proposal ? `Recorded your yes to: ${j.proposal.actionText}` : undefined,
      };
    } catch (err) {
      console.warn(`[finance] agents service unreachable for accept: ${(err as Error).message}`);
      return { ok: false, status: "pending", reason: "not_pending", message: "The proposals service did not answer, so nothing was changed. Try again." };
    }
  }

  async open(): Promise<ProposalSummary[]> {
    if (!this.opts.db) {
      // Without the database only the pending proposal is visible, so a transfer made after saying YES cannot be matched.
      const p = await this.pending();
      return p ? [p] : [];
    }
    const r = await this.opts.db.query<OpenRow>(
      "SELECT id, from_account, to_account, amount_cents, action_text, status, expires_at FROM proposals WHERE status IN ('pending', 'accepted') ORDER BY id DESC",
    );
    return r.rows.map((row) => ({
      id: String(row.id),
      actionText: row.action_text,
      amount: Number(row.amount_cents) / 100,
      from: row.from_account,
      to: row.to_account,
      status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
    }));
  }

  async complete(proposalId: string, txnId: string): Promise<boolean> {
    const id = Number(proposalId);
    if (!Number.isInteger(id) || id < 1) return false;
    const path = AGENT_ENDPOINTS.complete.path.replace(":id", String(id));
    const r = await this.call("POST", path, { txnId }); // throws if the service is unreachable, so the caller can retry
    return (r.json as { ok?: boolean } | null)?.ok === true;
  }
}

/**
 * The open proposal a user transfer fulfils: same accounts, and at least the proposed amount.
 * If several qualify (they should not, one is pending at a time) the newest wins.
 */
export function findMatchingProposal(
  transfer: { from: AccountId; to: AccountId; amount: number },
  open: ProposalSummary[],
): ProposalSummary | null {
  const matches = open.filter(
    (p) => (p.status === "pending" || p.status === "accepted") && p.from === transfer.from && p.to === transfer.to && transfer.amount + 0.005 >= p.amount,
  );
  return matches.sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}
