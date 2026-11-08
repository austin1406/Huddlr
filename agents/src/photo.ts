// "Can I afford this?" by photo or by text. Gemini only READS the photo (item + price); the answer always comes
// from P1's can_i_afford, so the verdict and every number in it are computed, not generated.
//
// Photo flow: the user texts a picture -> fetch the image (P3's /photon/attachments/:id) -> Gemini reads item and price
// -> confident: Checking answers with can_i_afford's verdict; unsure: ask "Is that $X for <item>?" and wait for a price.
import { readFileSync } from "node:fs";
import { TOOL_AUTH_HEADER, type CanIAffordResponse } from "../../contracts/src";
import { config } from "./character";
import { extractNumbers } from "./checker";
import type { Queryable } from "./db";
import type { Finance } from "./finance";
import { queueOutbox } from "./outbox";
import { geminiQuota, parseQuotaError, QuotaError } from "./quota";

export interface Image {
  bytes: Uint8Array;
  mime: string;
}
export interface PhotoReading {
  item: string | null;
  price: number | null;
  /** true only when both item and price are clearly visible */
  confident: boolean;
}
export type ReadPhoto = (image: Image) => Promise<PhotoReading>;
export type FetchImage = (attachmentId: string) => Promise<Image | null>;

const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The answer, built only from can_i_afford's numbers. */
export function affordText(r: CanIAffordResponse, item?: string | null): string {
  const what = `${usd(r.amount)}${item ? ` for ${item.toLowerCase()}` : ""}`;
  const low = r.lowestBalanceAfter;
  if (r.verdict === "yes") return `Yes, ${what} fits. Your lowest balance before payday would still be ${usd(low.balance)} on ${day(low.date)}.`;
  if (r.verdict === "tight")
    return `Tight: ${what} keeps you above zero, but your lowest balance would be ${usd(low.balance)} on ${day(low.date)}, under your ${usd(r.cushion)} cushion.`;
  return `Not right now: ${what} would put you ${usd(low.balance)} in the red${r.firstNegativeDateAfter ? ` on ${day(r.firstNegativeDateAfter)}` : ""}. Want the crew to find room?`;
}

/** Reads a short affordability question with exactly one dollar amount: "can I afford a $40 dinner?" */
export function parseAffordQuestion(text: string): { amount: number; item: string | null } | null {
  if (!/\bafford\b|\bcan i (buy|get|spend)\b|\bshould i (buy|get)\b/i.test(text)) return null;
  const money = extractNumbers(text).filter((n) => n.kind === "money");
  if (money.length !== 1 || !money[0].value || money[0].value <= 0) return null;
  const item = text.match(/\$[\d,.]+k?\s+([a-z][a-z\s'-]{1,30}?)(?:\s+(?:tonight|tonite|tn|today|now|rn|tomorrow|tmrw|this week)|[?.!]|$)/i)?.[1]?.trim() ?? null;
  return { amount: money[0].value, item };
}

/** Gemini vision: read the item and price off a photo. Returns structured JSON; never answers the question itself. */
export function geminiReader(apiKey: string, model = process.env.CHARACTER_MODEL || config.character_model.model): ReadPhoto {
  return async (image) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: image.mime, data: Buffer.from(image.bytes).toString("base64") } },
            { text: 'Read this photo of something the user may buy. Reply with JSON only: {"item": short name or null, "price": number in dollars or null, "confident": true only if both the item and an exact price are clearly visible}. Do not guess a price that is not shown.' },
          ],
        }],
        generationConfig: { maxOutputTokens: 80, temperature: 0, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) {
      const err = parseQuotaError(await res.text());
      geminiQuota.record(err);
      throw err;
    }
    if (!res.ok) throw new Error(`gemini vision ${res.status}`);
    geminiQuota.ok();
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Partial<PhotoReading>;
    const price = typeof j.price === "number" && j.price > 0 ? Math.round(j.price * 100) / 100 : null;
    return { item: typeof j.item === "string" && j.item.trim() ? j.item.trim().slice(0, 40) : null, price, confident: !!j.confident && price != null };
  };
}

/** P3 serves photo bytes at /photon/attachments/:id (shared secret). Returns null if it isn't available. */
export function httpImageFetcher(baseUrl: string, secret: string): FetchImage {
  return async (id) => {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/photon/attachments/${encodeURIComponent(id)}`, {
        headers: secret ? { [TOOL_AUTH_HEADER]: secret } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
    } catch {
      return null;
    }
  };
}

/** Local files, for npm run local and tests: attachment id = file path. */
export const fileImageFetcher: FetchImage = async (path) => {
  try {
    return { bytes: new Uint8Array(readFileSync(path)), mime: path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  }
};

interface PhotoDeps {
  db: Queryable;
  finance: Finance;
  userPhone: string;
  fetchImage?: FetchImage;
  readPhoto?: ReadPhoto;
}

const pendingKey = (phone: string) => `photo_pending:${phone}`;

/** Handles an inbound row that carries a photo. Claims the row once. */
export async function handlePhoto(
  deps: PhotoDeps,
  row: { id: number; user_phone: string; attachment_ids: string[] },
  now: Date,
): Promise<{ kind: "duplicate" | "answered" | "confirm" | "unreadable" | "unavailable"; amount?: number }> {
  const claimed = await deps.db.query("UPDATE inbound_messages SET processed_at = $2 WHERE id = $1 AND processed_at IS NULL RETURNING id", [row.id, now]);
  if (!claimed.rows[0]) return { kind: "duplicate" };
  await deps.db.query(
    "INSERT INTO memory_messages (user_phone, channel, direction, speaker, text, inbound_id, created_sim_at) VALUES ($1, 'text', 'in', 'user', '[photo]', $2, $3)",
    [row.user_phone, row.id, now],
  );
  const say = (key: string, text: string) =>
    queueOutbox(deps.db, {
      idempotency_key: `inbound:${row.id}:${key}`, user_phone: row.user_phone, speaker: "checking", text,
      reply_to: row.id, thread_key: `inbound:${row.id}`, priority: 1, created_sim_at: now.toISOString(),
    });

  const image = deps.fetchImage && row.attachment_ids[0] ? await deps.fetchImage(row.attachment_ids[0]) : null;
  if (!image || !deps.readPhoto || geminiQuota.limited()) {
    await say("photo", "I can't open photos right now. Text me the item and price, like \"headphones $79.99\", and I'll check if it fits.");
    return { kind: "unavailable" };
  }
  let reading: PhotoReading;
  try {
    reading = await deps.readPhoto(image);
  } catch (e) {
    await say("photo", e instanceof QuotaError
      ? "I can't read photos for a bit. Text me the price, like \"$79.99\", and I'll check if it fits."
      : "I couldn't read that photo. Text me the price, like \"$79.99\", and I'll check if it fits.");
    return { kind: "unreadable" };
  }
  if (reading.price == null) {
    await say("photo", `I can't see a price${reading.item ? ` for the ${reading.item.toLowerCase()}` : " in that photo"}. Text me the price and I'll check if it fits.`);
    await setPending(deps.db, row.user_phone, reading.item);
    return { kind: "unreadable" };
  }
  if (!reading.confident) {
    // Uncertain reading: confirm before computing anything with it.
    await say("photo", `Is that ${usd(reading.price)}${reading.item ? ` for the ${reading.item.toLowerCase()}` : ""}? Reply with the price to check, like "${usd(reading.price)}".`);
    await setPending(deps.db, row.user_phone, reading.item);
    return { kind: "confirm", amount: reading.price };
  }
  const r = await deps.finance.canIAfford(reading.price, reading.item ?? undefined);
  await say("afford", affordText(r, reading.item));
  return { kind: "answered", amount: reading.price };
}

async function setPending(db: Queryable, phone: string, item: string | null) {
  await db.query(
    `INSERT INTO agent_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [pendingKey(phone), JSON.stringify({ item })],
  );
}

/**
 * A text answer that is just a price ("$79.99") after we asked about a photo, or any "can I afford $X" question.
 * Returns the reply it queued, or null if this text isn't one of those.
 */
export async function maybeAnswerAfford(
  deps: { db: Queryable; finance: Finance; userPhone: string },
  inbound: { id: number; text: string },
  now: Date,
): Promise<string | null> {
  const pending = await deps.db.query<{ value: string }>("DELETE FROM agent_state WHERE key = $1 RETURNING value", [pendingKey(deps.userPhone)]);
  const priceOnly = extractNumbers(inbound.text).filter((n) => n.kind === "money");
  let ask: { amount: number; item: string | null } | null = null;
  if (pending.rows[0] && priceOnly.length === 1 && inbound.text.trim().split(/\s+/).length <= 4)
    ask = { amount: priceOnly[0].value!, item: (JSON.parse(pending.rows[0].value) as { item: string | null }).item };
  else ask = parseAffordQuestion(inbound.text);
  if (!ask) {
    if (pending.rows[0]) await deps.db.query("INSERT INTO agent_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [pendingKey(deps.userPhone), pending.rows[0].value]);
    return null;
  }
  const r = await deps.finance.canIAfford(ask.amount, ask.item ?? undefined);
  const text = affordText(r, ask.item);
  await queueOutbox(deps.db, {
    idempotency_key: `inbound:${inbound.id}:afford`, user_phone: deps.userPhone, speaker: "checking", text,
    reply_to: inbound.id, thread_key: `inbound:${inbound.id}`, priority: 1, created_sim_at: now.toISOString(),
  });
  return text;
}
