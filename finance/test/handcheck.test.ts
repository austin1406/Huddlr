// Hand-check of the forecast on later simulated dates (P1 timeline H17-18).
// Expected values come from an independent reference simulation written from the rules alone (a separate day-by-day
// walk from 2026-11-07 using persona.json), and the Nov 21 balance is also checked by arithmetic:
//   1186.50 - 14 x 38 - 65 (phone, Nov 12) - 90 (utilities, Nov 18) + 1650 (payday, Nov 20) = 2149.50
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySimStateStore } from "../../contracts/src";
import { PERSONA } from "../src/data/config";
import { EngineBackend } from "../src/engine/backend";
import { NoProposals } from "../src/proposals";

const T0 = Date.parse("2026-11-07T16:00:00.000Z"); // 10:00 in Chicago

interface Case {
  name: string;
  date: string;
  days: number;
  extraPurchase?: number;
  checkingAtStartOfDay: number;
  lowest: { date: string; balance: number };
  nextPayday: string;
  firstNegativeDate: string | null;
  safeToSpendUntilPayday: number;
  shortfall: { firstNegativeDate: string; lowestDate: string; amount: number; suggestedTransfer: number } | null;
  endOfHorizon: number;
}

const CASES: Case[] = [
  {
    name: "Nov 21: just after the Nov 20 payday",
    date: "2026-11-21", days: 14, checkingAtStartOfDay: 2149.5, lowest: { date: "2026-12-03", balance: 147.5 },
    nextPayday: "2026-12-04", firstNegativeDate: null, safeToSpendUntilPayday: 47.5, shortfall: null, endOfHorizon: 2218.5,
  },
  {
    name: "Nov 28: rent week, nothing wrong yet",
    date: "2026-11-28", days: 21, checkingAtStartOfDay: 1547.5, lowest: { date: "2026-12-03", balance: 147.5 },
    nextPayday: "2026-12-04", firstNegativeDate: null, safeToSpendUntilPayday: 47.5, shortfall: null, endOfHorizon: 1952.5,
  },
  {
    name: "Jan 15: payday today, crossing two month ends",
    date: "2027-01-15", days: 69, checkingAtStartOfDay: 1773.5, lowest: { date: "2027-01-28", balance: 2393.5 },
    nextPayday: "2027-01-29", firstNegativeDate: null, safeToSpendUntilPayday: 2293.5, shortfall: null, endOfHorizon: 4502.5,
  },
  {
    name: "Nov 28 after a $900 purchase: a shortfall opens at rent",
    date: "2026-11-28", days: 21, extraPurchase: 900, checkingAtStartOfDay: 647.5, lowest: { date: "2026-12-03", balance: -752.5 },
    nextPayday: "2026-12-04", firstNegativeDate: "2026-12-01", safeToSpendUntilPayday: -852.5,
    shortfall: { firstNegativeDate: "2026-12-01", lowestDate: "2026-12-03", amount: 752.5, suggestedTransfer: 852.5 }, endOfHorizon: 1052.5,
  },
];

for (const c of CASES) {
  test(`forecast hand-check, ${c.name}`, async () => {
    const backend = await EngineBackend.create({
      persona: PERSONA,
      store: new MemorySimStateStore({ offsetSeconds: 0, demoMode: false, updatedAt: new Date(T0).toISOString() }),
      gateway: new NoProposals(),
      realNow: () => T0,
    });
    await backend.engine.jumpDays(c.days);
    if (c.extraPurchase) await backend.engine.purchase({ amount: c.extraPurchase, merchant: "Best Buy" });
    const facts = await backend.facts();
    const fc = facts.forecast;

    assert.equal(facts.localDate, c.date);
    assert.equal(facts.accounts.find((a) => a.id === "checking")!.balance, c.checkingAtStartOfDay);
    assert.deepEqual(fc.lowest, c.lowest);
    assert.equal(fc.nextPayday, c.nextPayday);
    assert.equal(fc.firstNegativeDate, c.firstNegativeDate);
    assert.equal(fc.safeToSpendUntilPayday, c.safeToSpendUntilPayday);
    assert.equal(fc.days.at(-1)!.balance, c.endOfHorizon);
    assert.equal(fc.days.length, 45);
    if (c.shortfall) {
      const { amount, suggestedTransfer, firstNegativeDate, lowestDate } = facts.shortfall!;
      assert.deepEqual({ firstNegativeDate, lowestDate, amount, suggestedTransfer }, c.shortfall);
    } else {
      assert.equal(facts.shortfall, null);
    }
  });
}
