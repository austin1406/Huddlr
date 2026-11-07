// Number checker: every number a character says must come from the facts (or the plan).
// Pure code, no model. A message that fails is retried once (if time allows) or replaced by a template.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ALWAYS_ALLOWED = new Set([0, 1, 2, 3]);

export interface Grounded {
  values: number[];
  /** "11-14" month-day keys */
  dates: Set<string>;
}

export interface Found {
  raw: string;
  kind: "money" | "percent" | "number" | "date";
  value?: number;
  tolerance?: number;
  key?: string;
}

export interface CheckResult {
  ok: boolean;
  ungrounded: Array<{ raw: string; kind: Found["kind"] }>;
  found: number;
}

/**
 * Collect every number and date in facts/plan objects.
 * Fields ending in cents also count as dollars; percent fields also count as fractions; fractions as percents.
 */
export function collectGrounded(...sources: unknown[]): Grounded {
  const values: number[] = [];
  const dates = new Set<string>();
  const walk = (v: unknown, key = ""): void => {
    if (v == null) return;
    if (typeof v === "number" && Number.isFinite(v)) {
      values.push(v, Math.abs(v));
      if (/cents$/i.test(key)) values.push(v / 100, Math.abs(v) / 100);
      if (/(pct|percent|apr)$/i.test(key)) values.push(v / 100);
      if (Math.abs(v) <= 1 && v !== 0) values.push(v * 100);
    } else if (typeof v === "string") {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) dates.add(`${+m[2]}-${+m[3]}`);
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key));
    } else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!k.startsWith("_")) walk(x, k);
    }
  };
  sources.forEach((s) => walk(s));
  return { values, dates };
}

/** Find every number-ish token in text. */
export function extractNumbers(text: string): Found[] {
  const out: Found[] = [];
  let rest = text;
  const take = (re: RegExp, fn: (m: string[]) => Found | null): void => {
    rest = rest.replace(re, (...m: string[]) => {
      const item = fn(m.map((x) => (typeof x === "string" ? x : "")));
      if (item) out.push(item);
      return " ".repeat(m[0].length); // blank it so later patterns don't re-match
    });
  };

  // Dates: "2026-11-14", "Nov 14", "November 14th", "11/14", "11/14/2026"
  take(/\b\d{4}-(\d{1,2})-(\d{1,2})\b/g, (m) => ({ raw: m[0], kind: "date", key: `${+m[1]}-${+m[2]}` }));
  take(new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"), (m) => ({
    raw: m[0], kind: "date", key: `${MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1}-${+m[2]}`,
  }));
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g, (m) => ({ raw: m[0], kind: "date", key: `${+m[1]}-${+m[2]}` }));

  // Money and plain numbers: "-$1,234.56", "$1.2k", "24.99%", "1,234", "3 days"
  take(/(-)?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?([kK]\b)?(\s?%)?/g, (m) => {
    const [raw, neg, intPart, dec, k, pct] = m;
    if (!/\d/.test(raw)) return null;
    let value = parseFloat(`${intPart.replace(/,/g, "")}.${dec || "0"}`);
    let tolerance = 0.5 * 10 ** -dec.length; // "$1,235" covers 1234.50..1235.49
    if (k) { value *= 1000; tolerance *= 1000; }
    if (neg) value = -value;
    // Rounded speech: "$840" may stand for 842.17, "$11,500" for 11,480. Allow half the place of the last
    // non-zero digit (840 -> ±5, 11,500 -> ±50), capped at 1% so "$850" does NOT pass for 842.17.
    if (!dec && !k) {
      const digits = intPart.replace(/,/g, "");
      const zeros = digits.length - digits.replace(/0+$/, "").length;
      if (zeros > 0 && zeros < digits.length) tolerance = Math.min(0.5 * 10 ** zeros, Math.abs(value) * 0.01);
    }
    return { raw: raw.trim(), kind: pct ? "percent" : raw.includes("$") ? "money" : "number", value, tolerance };
  });
  return out;
}

/** Check a message against facts (and optionally a plan). */
export function checkMessage(text: string, ...sources: unknown[]): CheckResult {
  const { values, dates } = collectGrounded(...sources);
  const found = extractNumbers(text);
  const ungrounded = found.filter((n) => {
    if (n.kind === "date") return !dates.has(n.key!);
    const v = n.value!;
    const tol = n.tolerance! + 1e-9;
    if (ALWAYS_ALLOWED.has(v)) return false;
    return !values.some((f) => Math.abs(f - v) <= tol || Math.abs(f + v) <= tol);
  });
  return { ok: ungrounded.length === 0, ungrounded: ungrounded.map(({ raw, kind }) => ({ raw, kind })), found: found.length };
}
