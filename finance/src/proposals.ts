import {
  AGENT_ENDPOINTS,
  AGENTS_BASE_PATH,
  TOOL_AUTH_HEADER,
  type AcceptProposalResponse,
  type ProposalSummary,
} from "../../contracts/src";

/**
 * The finance tools get_pending_proposal and accept_proposal are thin wrappers: the agents service owns the
 * proposals table and every rule (duplicates, expiry, "unclear means no"). This is the seam to it.
 */
export interface ProposalGateway {
  pending(): Promise<ProposalSummary | null>;
  accept(proposalId: string, via: "text" | "voice"): Promise<AcceptProposalResponse>;
}

/** No agents service: nothing is ever pending. Used in tests and when AGENTS_URL is not set. */
export class NoProposals implements ProposalGateway {
  async pending(): Promise<ProposalSummary | null> {
    return null;
  }
  async accept(): Promise<AcceptProposalResponse> {
    return { ok: false, status: "declined", reason: "not_found", message: "No such proposal." };
  }
}

export class HttpProposalGateway implements ProposalGateway {
  /** `baseUrl` is the agents service origin, for example http://localhost:5000 */
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 2000,
  ) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${AGENTS_BASE_PATH}${path}`, {
      method,
      headers: { ...(this.secret ? { [TOOL_AUTH_HEADER]: this.secret } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
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
}
