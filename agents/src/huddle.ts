// The Huddle page (P3's dashboard service): every account at one table, behind a code texted to this chat.
// The welcome text includes a link, and "huddle link" (or similar) gets a fresh one at any time.
// Links come from P3's POST /me-link; a new link cancels that phone's older ones.
import type { Queryable } from "./db";
import { queueOutbox } from "./outbox";

/** "huddle link", "send me my huddle", "resend the link", "open the table", "where's my huddle page". */
export const isHuddleLinkRequest = (text: string | null | undefined): boolean => {
  const t = (text ?? "").toLowerCase().replace(/[’']/g, "").trim();
  if (!t || t.length > 120) return false;
  if (/\bhuddle\b/.test(t) && /\b(link|url|page|site|open|send|resend|new|again|where|wheres|access|get|give|table|view)\b/.test(t)) return true;
  if (/^(huddle|my huddle|the huddle)[.!?]*$/.test(t)) return true;
  // Phone testing: "can i get the link", "where is the link", "link" went to a character, who said it can't give links.
  if (/^(the |my |a )?(new )?(link|dashboard|dashboard link|table link)[.!?]*$/.test(t)) return true;
  if (/^(where|wheres|where is)( is)? (the|my) (link|dashboard|table)\b/.test(t)) return true;
  if (/^(can|could|may) (i|u|you) (get|have|see|send me|give me|text me|resend)( me)?( the| a| my)?( new)? (link|dashboard|dashboard link|table link|table)\b/.test(t)) return true;
  return /^(can you |could you |can u |pls |please )?(send|give|text|resend|get)( me)?( my| the| a)?( new)? (link|table link|dashboard link)\b/.test(t);
};

export type HuddleLink = (phone: string) => Promise<string | null>;

/** Asks P3's dashboard for a fresh link. Null if the dashboard is unreachable (the caller says so). */
export function huddleLinkClient(dashboardUrl: string, secret: string): HuddleLink {
  return async (phone) => {
    try {
      const r = await fetch(`${dashboardUrl.replace(/\/$/, "")}/me-link`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-huddlr-secret": secret },
        body: JSON.stringify({ phone }),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { url?: string };
      return typeof j.url === "string" && j.url.startsWith("http") ? j.url : null;
    } catch {
      return null;
    }
  };
}

export const huddleLinkText = (url: string) =>
  `Here's your Huddle, with all your accounts at one table: ${url} It works for 24 hours, and you'll get a code here to open it. Asking for a new link turns off the old one.`;
export const HUDDLE_LINK_FAILED = "I couldn't make your Huddle link just now. Try again in a minute.";

/** Answers a link request with a fresh link (threaded to the user's text). */
export async function replyWithHuddleLink(
  db: Queryable,
  getLink: HuddleLink,
  row: { id: number; user_phone: string },
  now: Date,
): Promise<"sent" | "failed"> {
  const url = await getLink(row.user_phone);
  await queueOutbox(db, {
    idempotency_key: `inbound:${row.id}:huddle-link`, user_phone: row.user_phone, speaker: "coach",
    text: url ? huddleLinkText(url) : HUDDLE_LINK_FAILED,
    reply_to: row.id, thread_key: `inbound:${row.id}`, priority: 1, created_sim_at: now.toISOString(),
  });
  return url ? "sent" : "failed";
}
