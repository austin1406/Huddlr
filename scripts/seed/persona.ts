// The parts of contracts/persona.json the seed script reads.
// P1 owns persona.json. This is P4's assumption until P1's contract merges:
// if P1's shape differs, adapt loadPersona() below, not the rest of the seed.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Persona {
  customer: { first_name: string; last_name: string };
  accounts: {
    checking: { balance: number };
    savings: { balance: number };
    credit_card: { balance: number };
    // Car loan and IRA are simulated by the finance engine, not stored in Nessie.
  };
  paycheck: { amount: number; every_days: number; last_date: string };
  bills: { payee: string; amount: number; day_of_month: number }[];
  daily_spend: { min: number; max: number };
  merchants: { name: string; category: string }[];
  p2p: { payee: string; amount: number; days_ago: number }[];
  history_days: number;
}

const CONTRACT = fileURLToPath(new URL("../../contracts/persona.json", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("./persona.example.json", import.meta.url));

export function loadPersona(): Persona {
  if (existsSync(CONTRACT)) return JSON.parse(readFileSync(CONTRACT, "utf8")) as Persona;
  console.warn("contracts/persona.json not found yet, using seed/persona.example.json");
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Persona;
}
