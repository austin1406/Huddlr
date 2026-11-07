import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Shared .env at the repo root (on the VM: /opt/huddlr/.env).
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export type ScenarioName = "normal" | "shortfall";

export const env = {
  /** Caddy routes /facts* and /tools/* to this port. */
  port: Number(process.env.FINANCE_PORT || 4000),
  huddlrSecret: process.env.HUDDLR_SECRET || "",
  /** Which fixture the stub serves by default. Switch live with POST /admin/scenario. */
  scenario: (process.env.FINANCE_SCENARIO === "shortfall" ? "shortfall" : "normal") as ScenarioName,
};
