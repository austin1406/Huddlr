// Reply classifier for proposals. The safety rule: only an unambiguous yes accepts.
// Anything mixed, hedged, conditional, or a question is "unclear", which is treated as not approved.
import type { ReplyIntent } from "../../contracts/src";

const YES = [
  "yes", "y", "yep", "yup", "yeah", "ya", "yea", "sure", "ok", "okay", "k", "do it", "go ahead", "approve", "approved",
  "confirm", "confirmed", "sounds good", "lets do it", "let's do it", "go for it", "move it", "send it", "absolutely", "👍", "✅",
];
const NO = [
  "no", "n", "nope", "nah", "not now", "not yet", "decline", "declined", "cancel", "stop", "skip", "pass", "dont",
  "don't", "do not", "no thanks", "no thank you", "leave it", "👎", "❌",
];
/** Words that make a yes conditional or uncertain. */
const HEDGES = ["but", "maybe", "wait", "hold on", "hmm", "if", "unless", "later", "think", "not sure", "idk", "?", "how", "why", "what", "instead", "only", "half", "less", "more"];
/** Polite filler that doesn't change meaning. */
const FILLER = ["please", "pls", "plz", "thanks", "thank you", "thank", "you", "thx", "ty", "coach", "lol", "!", ".", ",", "yes", "go", "ahead", "it", "do", "sure", "ok", "okay"];

const norm = (s: string) =>
  ` ${s.toLowerCase().replace(/[’']/g, "'").replace(/([!?.,])/g, " $1 ").replace(/\s+/g, " ").trim()} `;

const has = (text: string, phrase: string) => text.includes(` ${phrase} `);

export function classifyReply(raw: string | null | undefined): ReplyIntent {
  if (!raw || !raw.trim()) return "unclear";
  const t = norm(raw);
  const yes = YES.some((p) => has(t, p));
  const no = NO.some((p) => has(t, p));
  const hedge = HEDGES.some((p) => has(t, p));

  if (yes && no) return "unclear"; // "yes no", "ok don't"
  if (no) return hedge && !/^ (no|nope|nah|n) /.test(t) ? "unclear" : "no";
  if (!yes || hedge) return "unclear";

  // A yes must be short and only yes-words or filler, so "yes the other plan" doesn't count.
  const words = t.trim().split(" ");
  const yesWords = new Set(YES.flatMap((p) => p.split(" ")));
  const extra = words.filter((w) => !yesWords.has(w) && !FILLER.includes(w));
  return extra.length === 0 && words.length <= 6 ? "yes" : "unclear";
}
