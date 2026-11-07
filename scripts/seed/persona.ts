// Loads contracts/persona.json (P1 owns it).
// The type below mirrors P1's zod schema in contracts/src/persona.ts (PR #4), trimmed to the fields
// the seed reads. TODO once #4 merges: replace with `import { Persona } from "@huddlr/contracts"`
// and validate with `Persona.parse(...)`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Persona {
  version: 1;
  customer: { id: string; firstName: string; lastName: string };
  accounts: {
    checking: { balance: number };
    savings: { balance: number };
    card: { balance: number };
    // card limit/APR, carLoan, and ira are simulated by the finance engine, not stored in Nessie.
  };
  income: { paycheckAmount: number; everyDays: number; lastPaidDaysAgo: number };
  recurringBills: { id: string; label: string; amount: number; dayOfMonth: number; essential: boolean }[];
  spending: { averageDailyDiscretionary: number };
  peers: { name: string; relationship: string; owesUser: number }[];
  seedHints: {
    historyDays: number;
    merchants: { name: string; category: string; typicalAmount: [number, number]; perWeek: number }[];
  };
}

const CONTRACT = fileURLToPath(new URL("../../contracts/persona.json", import.meta.url));
// Copy of P1's persona.json from PR #4, used only until that PR merges. Delete it afterwards.
const FALLBACK = fileURLToPath(new URL("./persona.example.json", import.meta.url));

export function loadPersona(): Persona {
  const path = existsSync(CONTRACT) ? CONTRACT : FALLBACK;
  if (path === FALLBACK) console.warn("contracts/persona.json not found yet, using seed/persona.example.json");
  const p = JSON.parse(readFileSync(path, "utf8")) as Persona;
  if (p.version !== 1 || !p.seedHints?.merchants?.length || !p.income || !p.recurringBills) {
    throw new Error(`${path} does not match the persona contract (version 1)`);
  }
  return p;
}
