// The user's money priorities, from what they text: "prioritize my IRA over savings", "pay off the card first",
// "don't touch my savings", "reset my priorities". Saved as one memory fact (pref:priorities) and used to:
//   - pick which part of a plan the YES moves first (and update a plan that's already waiting),
//   - tell P1's planner (get_plan `priorities`, ignored until the planner supports it),
//   - tell the Coach, so it says the plan follows them.
// Safety stays first: a shortfall in Checking is always covered before anything the user ranks.
// Pattern-based on purpose, like the rest of memory: no model call, nothing invented.
import type { AccountId, Plan, PlanLine } from "../../contracts/src";
import type { Queryable } from "./db";

export type Pot = "checking" | "savings" | "card" | "car_loan" | "ira";
export interface Priorities {
  /** Fund these first, in this order (after a shortfall). */
  first: Pot[];
  /** Fund these last. */
  last: Pot[];
  /** Never suggest moving money out of these. */
  protect: Pot[];
}

export const NAMES: Record<Pot, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Loan", ira: "IRA" };

const ACCT = String.raw`(checking|savings?|emergency fund|cushion|credit cards?|cards?|debt|car loan|auto loan|student loans?|mortgage|loans?|car|ira|roth|retirement|401\s?k)`;
const toPot = (s: string): Pot | null => {
  const t = s.toLowerCase().replace(/\s+/g, " ");
  if (t === "checking") return "checking";
  if (/^(savings?|emergency fund|cushion)$/.test(t)) return "savings";
  if (/^(credit cards?|cards?|debt)$/.test(t)) return "card";
  if (/^(car loan|auto loan|student loans?|mortgage|loans?|car)$/.test(t)) return "car_loan";
  if (/^(ira|roth|retirement|401 ?k)$/.test(t)) return "ira";
  return null;
};
const P = (s: string) => new RegExp(s.replace(/ACCT/g, ACCT).replace(/MY/g, String.raw`(?:my |the |our )?`), "i");

/** What a text says about priorities, or null if it says nothing about them. */
export function parsePriorities(text: string): (Partial<Priorities> & { clear?: boolean }) | null {
  const t = text.trim();
  // A question asks for advice; it doesn't set priorities ("should I pay off my card or build savings first?").
  if (/\?\s*$/.test(t) || /^(should|what|which|how|why|can|could|would|is|are|do|does)\b/i.test(t)) return null;
  if (/\b(reset|clear|forget|remove|drop)\b[^.?!]*\bpriorit/i.test(t) || /\bno (more )?priorities\b/i.test(t)) return { clear: true };
  const out: Partial<Priorities> = {};
  const add = (k: keyof Priorities, p: Pot | null) => p && !(out[k] ??= []).includes(p) && out[k]!.push(p);

  // Protect: "don't touch my savings", "leave savings alone", "keep my savings intact", "never take from savings"
  for (const re of [P(String.raw`\b(?:don'?t|do not|never|stop)\s+(?:touch|take (?:money )?(?:from|out of)|use|pull from|dip into|withdraw from)\s+MYACCT\b`), P(String.raw`\bleave\s+MYACCT\s+alone\b`), P(String.raw`\bkeep\s+MYACCT\s+(?:intact|safe|untouched|as is)\b`)]) {
    const m = t.match(re);
    if (m) add("protect", toPot(m[1]));
  }

  // Comparative: "prioritize IRA over savings", "IRA before savings", "card is more important than savings",
  // "I care more about savings than the card", "put retirement ahead of debt"
  const trigger = /\b(priorit\w*|first|focus|more important|care more|rather|before|ahead of|over)\b/i.test(t);
  const cmp =
    t.match(P(String.raw`\bMYACCT\s+(?:over|before|ahead of|instead of|rather than|more than)\s+MYACCT\b`)) ??
    t.match(P(String.raw`\bMYACCT\s+(?:is|are)\s+more important than\s+MYACCT\b`));
  const careMore = t.match(P(String.raw`\bcare more about\s+MYACCT\s+than\s+MYACCT\b`));
  if (trigger && (cmp || careMore)) {
    const m = (cmp ?? careMore)!;
    add("first", toPot(m[1]));
    add("last", toPot(m[2]));
  }

  // Ordered: "card first, then savings"
  const ordered = t.match(P(String.raw`\bMYACCT\s+first,?\s+(?:and\s+)?then\s+MYACCT\b`));
  if (ordered) {
    add("first", toPot(ordered[1]));
    add("first", toPot(ordered[2]));
  }

  // Single: "prioritize my IRA", "focus on the card", "pay off the card first", "savings first", "IRA is my top priority"
  if (!out.first?.length) {
    const single =
      t.match(P(String.raw`\b(?:prioriti[sz]e|focus on|focusing on|put (?:everything|it|money|extra) (?:in|into|toward|towards))\s+MYACCT\b`)) ??
      t.match(P(String.raw`\b(?:pay (?:off|down)\s+)?MYACCT\s+(?:first|comes first|should come first)\b`)) ??
      t.match(P(String.raw`\bMYACCT\s+(?:is|are)\s+(?:my |the )?(?:top|first|#1|number one|main|biggest) priority\b`));
    if (single) add("first", toPot(single[1]));
  }

  // Last: "savings can wait", "deprioritize the car loan", "IRA last"
  const last = t.match(P(String.raw`\bMYACCT\s+(?:can wait|last|comes last)\b`)) ?? t.match(P(String.raw`\bdeprioriti[sz]e\s+MYACCT\b`));
  if (last) add("last", toPot(last[1]));

  if (out.last) out.last = out.last.filter((p) => !out.first?.includes(p));
  if (out.last && !out.last.length) delete out.last;
  return out.first?.length || out.last?.length || out.protect?.length ? out : null;
}

/** New statements win: what's ranked first moves to the front, and nothing is both first and last. */
export function mergePriorities(old: Priorities | null, change: Partial<Priorities> & { clear?: boolean }): Priorities {
  if (change.clear) return { first: [], last: [], protect: [] };
  const base = old ?? { first: [], last: [], protect: [] };
  const first = [...(change.first ?? []), ...base.first.filter((p) => !change.first?.includes(p) && !change.last?.includes(p))];
  const last = [...base.last.filter((p) => !first.includes(p) && !change.last?.includes(p)), ...(change.last ?? [])];
  const protect = [...new Set([...base.protect, ...(change.protect ?? [])])];
  return { first, last, protect };
}

export async function loadPriorities(db: Queryable, phone: string): Promise<Priorities | null> {
  const r = await db.query<{ value: Priorities | string }>("SELECT value FROM memory_facts WHERE user_phone = $1 AND key = 'pref:priorities'", [phone]);
  const v = r.rows[0]?.value;
  if (!v) return null;
  const p = (typeof v === "string" ? JSON.parse(v) : v) as Priorities;
  return p.first.length || p.last.length || p.protect.length ? p : null;
}

export async function savePriorities(db: Queryable, phone: string, p: Priorities, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO memory_facts (user_phone, kind, key, value, source, created_sim_at, updated_sim_at)
     VALUES ($1, 'preference', 'pref:priorities', $2, 'text', $3, $3)
     ON CONFLICT (user_phone, key) DO UPDATE SET value = EXCLUDED.value, updated_sim_at = EXCLUDED.updated_sim_at`,
    [phone, JSON.stringify(p), now],
  );
}

const list = (ps: Pot[]) => (ps.length > 1 ? `${ps.slice(0, -1).map((p) => NAMES[p]).join(", ")} and ${NAMES[ps.at(-1)!]}` : NAMES[ps[0]]);

/** "IRA first, then Card; Savings last; never take from Savings" (for prompts and the summary). */
export function describePriorities(p: Priorities | null): string | null {
  if (!p) return null;
  const parts = [
    ...(p.first.length ? [`${p.first.map((x) => NAMES[x]).join(", then ")} first`] : []),
    ...(p.last.length ? [`${list(p.last)} last`] : []),
    ...(p.protect.length ? [`never take from ${list(p.protect)}`] : []),
  ];
  return parts.length ? parts.join("; ") : null;
}

/** The confirmation for what was just said. Uses only account names, no numbers. */
export function priorityAck(change: Partial<Priorities> & { clear?: boolean }): string {
  if (change.clear) return "Got it, priorities cleared. Plans go back to the usual order.";
  const bits: string[] = [];
  if (change.first?.length && change.last?.length) bits.push(`${list(change.first)} comes before ${list(change.last)} when there's money to place.`);
  else if (change.first?.length) bits.push(`${list(change.first)} comes first when there's money to place.`);
  else if (change.last?.length) bits.push(`${list(change.last)} goes last when there's money to place.`);
  if (change.protect?.length) bits.push(`I won't suggest moving money out of ${list(change.protect)}.`);
  const safety = change.first?.length || change.last?.length ? " A shortfall in Checking still gets covered first, so you're never short." : "";
  return `Got it: ${bits.join(" ")}${safety}`;
}

/**
 * Which plan line the YES should move. A shortfall line always wins (safety). Otherwise the line whose destination
 * the user ranks highest; lines they put last lose; ties keep P1's order. For a bonus (`windfall`), the money is
 * already in Checking, so Checking lines are "keep" lines and never the YES.
 */
export function pickLine(plan: Plan, p: Priorities | null, opts: { windfall?: boolean } = {}): PlanLine | null {
  const lines = plan.lines.filter((l) => l.amount > 0 && !String(l.destination).startsWith("goal:") && !(opts.windfall && l.destination === "checking"));
  if (!lines.length) return null;
  const shortfall = !opts.windfall && lines.find((l) => l.reasonCode === "cover_shortfall");
  if (shortfall) return shortfall;
  const rank = (l: PlanLine, i: number) => {
    const d = l.destination as Pot;
    const f = p?.first.indexOf(d) ?? -1;
    if (f >= 0) return f;
    if (p?.last.includes(d)) return 1000 + i;
    return 100 + i;
  };
  return lines.map((l, i) => ({ l, r: rank(l, i) })).sort((a, b) => a.r - b.r)[0].l;
}

/** The plan with the chosen line first (the Coach's "who is right" rule follows the first line). */
export function leadWith(plan: Plan, line: PlanLine | null): Plan {
  return line ? { ...plan, lines: [line, ...plan.lines.filter((l) => l !== line)] } : plan;
}

/** Where the money for a line comes from: a bonus is already in Checking; a Checking top-up comes from Savings. */
export function fromFor(line: PlanLine, windfall: boolean): AccountId {
  return windfall || line.destination !== "checking" ? "checking" : "savings";
}

const LABEL: Record<string, string> = { checking: "Checking", savings: "Savings", card: "Card", car_loan: "Loan", ira: "IRA" };
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Every move in a plan, in one sentence, the lead line first: "Move $150.00 from Checking to IRA and $450.00 from
 * Checking to Card". The user makes all of them in their bank app (the Coach can't move money), so the Coach lists
 * them all instead of only the first. Goal lines are skipped; for a bonus, Checking lines are "keep", not moves.
 */
export function allMovesText(plan: Plan, lead: PlanLine | null, opts: { windfall?: boolean } = {}): string | null {
  const moves = plan.lines.filter((l) => l.amount > 0 && !String(l.destination).startsWith("goal:") && !(opts.windfall && l.destination === "checking"));
  const ordered = lead && moves.includes(lead) ? [lead, ...moves.filter((l) => l !== lead)] : moves;
  if (!ordered.length) return null;
  const parts = ordered.map((l) => `${money(l.amount)} from ${LABEL[fromFor(l, opts.windfall ?? false)]} to ${LABEL[String(l.destination)] ?? String(l.destination)}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Move ${list}`;
}
