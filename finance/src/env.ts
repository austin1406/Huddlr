import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Shared .env at the repo root (on the VM: /opt/huddlr/.env).
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export type ScenarioName = "normal" | "shortfall";

export const env = {
  /** Caddy routes /facts* and /tools/* to this port. */
  port: Number(process.env.FINANCE_PORT || 4000),
  huddlrSecret: process.env.HUDDLR_SECRET || "",
  /** engine: the real forecast over the persona's ledger. stub: the contract fixtures only. */
  mode: (process.env.FINANCE_MODE === "stub" ? "stub" : "engine") as "stub" | "engine",
  /** Stub only: which fixture to serve first. Switch live with POST /admin/scenario. */
  scenario: (process.env.FINANCE_SCENARIO === "shortfall" ? "shortfall" : "normal") as ScenarioName,
  /** Shared Postgres. Holds the sim_state row the other services read. Without it the clock is kept in a local file. */
  databaseUrl: process.env.DATABASE_URL || "",
  /** Where get_pending_proposal and accept_proposal are forwarded (the agents service, Caddy path /agents). */
  agentsUrl: process.env.AGENTS_URL || `http://localhost:${process.env.AGENTS_PORT || 5000}`,
  /** Ledger, event log and (without a database) the clock survive restarts here. Git-ignored. */
  dataDir: process.env.FINANCE_DATA_DIR || fileURLToPath(new URL("../.data", import.meta.url)),
};
