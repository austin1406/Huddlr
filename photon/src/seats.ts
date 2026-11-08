/**
 * Seat tool: give a phone a seat on the shared iMessage line without the dashboard.
 *
 *   npm run seat -- add 4695551234 "Judge Alex"   → prints the agent number that phone should text
 *   npm run seat -- list                          → everyone seated, and how many seats are left
 *
 * Re-running `add` for the same phone is safe (same idempotency key → same seat).
 * The person must text the agent number first; until then the outbox holds their messages.
 */
import { Photon } from "@photon-ai/api";
import { env } from "./env.js";

export const SEAT_LIMIT = 25;

/** "4695551234", "(469) 555-1234", "+1 469 555 1234" → "+14695551234". Emails pass through. */
export function normalizeHandle(raw: string): string {
  const s = raw.trim();
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+") && digits.length >= 8) return `+${digits}`;
  throw new Error(`"${raw}" doesn't look like a phone number (use 10 digits, or +country code)`);
}

const pretty = (e164: string) => {
  const d = e164.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e164;
};

async function main() {
  const [cmd, who, ...nameParts] = process.argv.slice(2);
  const photon = new Photon({ headers: { Authorization: `Bearer ${env.apiKey()}` } });
  const project = env.projectId();

  if (cmd === "add" && who) {
    const handle = normalizeHandle(who);
    const [firstName, ...rest] = nameParts.join(" ").trim().split(/\s+/).filter(Boolean);
    const seat = await photon.projects.platforms.imessage.assignments.create({
      path: { id: project },
      headers: { idempotencyKey: `seat:${handle}` },
      body: {
        ...(handle.includes("@") ? { handle: handle as any, email: handle } : { handle: handle as any }),
        ...(firstName ? { firstName } : {}),
        ...(rest.length ? { lastName: rest.join(" ") } : {}),
      },
    });
    console.log(`\nSeated ${pretty(handle)}${firstName ? ` (${nameParts.join(" ")})` : ""}`);
    console.log(`\n  ➜ They text:  ${pretty(seat.assignedPhoneNumber)}   (send "hi" first, as a blue iMessage)\n`);
    console.log("Until they text, anything the agents send them waits in the outbox as 'held'.");
    return;
  }

  if (cmd === "list") {
    const rows: { handle: string; assignedPhoneNumber: string; firstName?: string; lastName?: string; createdAt: string }[] = [];
    let pageToken: string | undefined;
    do {
      const page: any = await photon.projects.platforms.imessage.assignments.list({
        path: { id: project },
        query: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      });
      rows.push(...(page.assignments ?? []));
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
    console.log(`\n${rows.length} of ${SEAT_LIMIT} seats used\n`);
    for (const r of rows) {
      const name = [r.firstName, r.lastName].filter(Boolean).join(" ");
      console.log(`  ${pretty(r.handle).padEnd(16)} → texts ${pretty(r.assignedPhoneNumber).padEnd(16)} ${name}`);
    }
    console.log();
    return;
  }

  console.log('Usage:\n  npm run seat -- add <phone> ["Name"]\n  npm run seat -- list');
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("seats.ts")) {
  main().catch((err) => {
    const body = (err as any)?.body;
    console.error(`\nSeat tool failed: ${body?.title ?? (err as Error).message}${body?.detail ? ` (${body.detail})` : ""}`);
    if (body?.code === "SHARED_LINE_POOL_EXHAUSTED" || /exhaust/i.test(body?.title ?? "")) console.error("All seats are used. Ask Photon staff for more, or reuse a teammate's phone.");
    process.exitCode = 1;
  });
}
