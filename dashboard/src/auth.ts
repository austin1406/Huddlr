/**
 * Logging in to the Huddle page: the link + a code texted to the same iMessage chat.
 *
 * 1. The link (signed, expires) says which phone this page is for. Asking for a new link cancels older ones.
 * 2. Opening it asks for a 6-digit code, which we text to that phone through the normal outbox.
 * 3. The right code gives this browser a 24-hour session (an httpOnly cookie). Only a hash is stored.
 *    Asking for a new link signs out every device, so the new link always asks for a code.
 * So getting in needs the link AND the phone. Nothing here can move money either way.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Db } from "./state.js";

export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 24 * 3600_000;
export const RESEND_AFTER_MS = 30_000;
export const MAX_SENDS_PER_HOUR = 5;
export const MAX_TRIES = 5;

export async function migrateAuth(db: Db): Promise<void> {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS p3_huddle_codes (
       user_phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
       tries SMALLINT NOT NULL DEFAULT 0, sent_at TIMESTAMPTZ NOT NULL,
       hour_started TIMESTAMPTZ NOT NULL, sends_this_hour SMALLINT NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS p3_huddle_sessions (
       token_hash TEXT PRIMARY KEY, user_phone TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS p3_huddle_links (user_phone TEXT PRIMARY KEY, not_before BIGINT NOT NULL)`,
  ])
    await db.query(sql);
}

const hash = (secret: string, ...parts: string[]) => createHash("sha256").update([secret, ...parts].join("|")).digest("hex");

// ---------- links ----------
/** Links issued before this moment (unix seconds) no longer work. */
export async function linksValidFrom(db: Db, phone: string): Promise<number> {
  const r = await db.query<{ not_before: string }>(`SELECT not_before FROM p3_huddle_links WHERE user_phone = $1`, [phone]);
  return r.rows[0] ? Number(r.rows[0].not_before) : 0;
}

/** A new link turns off older links AND signs out every device, so opening it always asks for a fresh code. */
export async function cancelOlderLinks(db: Db, phone: string, nowMs = Date.now()): Promise<void> {
  await db.query(`DELETE FROM p3_huddle_sessions WHERE user_phone = $1`, [phone]);
  await db.query(
    `INSERT INTO p3_huddle_links (user_phone, not_before) VALUES ($1, $2)
     ON CONFLICT (user_phone) DO UPDATE SET not_before = EXCLUDED.not_before`,
    [phone, Math.floor(nowMs / 1000)],
  );
}

// ---------- codes ----------
export type SendResult = { ok: true; code: string } | { ok: false; reason: "wait" | "limit"; retryInSeconds: number };

/** Makes a new code (replacing any old one), within the resend and hourly limits. */
export async function newCode(db: Db, secret: string, phone: string, nowMs = Date.now()): Promise<SendResult> {
  const r = await db.query<{ sent_at: Date; hour_started: Date; sends_this_hour: number }>(
    `SELECT sent_at, hour_started, sends_this_hour FROM p3_huddle_codes WHERE user_phone = $1`,
    [phone],
  );
  const prev = r.rows[0];
  let hourStarted = nowMs;
  let sends = 1;
  if (prev) {
    const sentAt = new Date(prev.sent_at).getTime();
    if (nowMs - sentAt < RESEND_AFTER_MS) return { ok: false, reason: "wait", retryInSeconds: Math.ceil((RESEND_AFTER_MS - (nowMs - sentAt)) / 1000) };
    const started = new Date(prev.hour_started).getTime();
    if (nowMs - started < 3600_000) {
      if (prev.sends_this_hour >= MAX_SENDS_PER_HOUR) return { ok: false, reason: "limit", retryInSeconds: Math.ceil((3600_000 - (nowMs - started)) / 1000) };
      hourStarted = started;
      sends = Number(prev.sends_this_hour) + 1;
    }
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(
    `INSERT INTO p3_huddle_codes (user_phone, code_hash, expires_at, tries, sent_at, hour_started, sends_this_hour)
     VALUES ($1, $2, $3, 0, $4, $5, $6)
     ON CONFLICT (user_phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, tries = 0,
       sent_at = EXCLUDED.sent_at, hour_started = EXCLUDED.hour_started, sends_this_hour = EXCLUDED.sends_this_hour`,
    [phone, hash(secret, phone, code), new Date(nowMs + CODE_TTL_MS), new Date(nowMs), new Date(hourStarted), sends],
  );
  return { ok: true, code };
}

export type CheckResult = "ok" | "wrong" | "expired" | "too_many" | "none";

/** One try at the code. Five wrong tries or ten minutes and the code is gone. */
export async function checkCode(db: Db, secret: string, phone: string, code: string, nowMs = Date.now()): Promise<CheckResult> {
  const r = await db.query<{ code_hash: string; expires_at: Date; tries: number }>(
    `SELECT code_hash, expires_at, tries FROM p3_huddle_codes WHERE user_phone = $1`,
    [phone],
  );
  const row = r.rows[0];
  if (!row || row.code_hash === "") return "none";
  if (new Date(row.expires_at).getTime() < nowMs) return "expired";
  if (Number(row.tries) >= MAX_TRIES) return "too_many";
  const clean = String(code).replace(/\D/g, "");
  if (clean.length === 6 && hash(secret, phone, clean) === row.code_hash) {
    await db.query(`UPDATE p3_huddle_codes SET code_hash = '', tries = 0 WHERE user_phone = $1`, [phone]); // single use
    return "ok";
  }
  await db.query(`UPDATE p3_huddle_codes SET tries = tries + 1 WHERE user_phone = $1`, [phone]);
  return Number(row.tries) + 1 >= MAX_TRIES ? "too_many" : "wrong";
}

/** The text that carries the code. Sent as "system", so it shows without a character name. */
export const codeMessage = (code: string) => `Your Huddle code is ${code}. It expires in 10 minutes. Never share it with anyone.`;

/** Queue the code for Photon's sender, ahead of everything else. */
export async function queueCode(db: Db, phone: string, code: string, nowMs = Date.now()): Promise<void> {
  await db.query(
    `INSERT INTO outbox (idempotency_key, user_phone, speaker, text, priority, created_sim_at)
     VALUES ($1, $2, 'system', $3, 2, now())`,
    [`huddle-code:${phone}:${nowMs}`, phone, codeMessage(code)],
  );
}

// ---------- sessions ----------
export async function newSession(db: Db, secret: string, phone: string, nowMs = Date.now()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(`DELETE FROM p3_huddle_sessions WHERE expires_at < $1`, [new Date(nowMs)]);
  await db.query(`INSERT INTO p3_huddle_sessions (token_hash, user_phone, expires_at) VALUES ($1, $2, $3)`, [
    hash(secret, "session", token),
    phone,
    new Date(nowMs + SESSION_TTL_MS),
  ]);
  return token;
}

export async function sessionPhone(db: Db, secret: string, token: string | undefined, nowMs = Date.now()): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const r = await db.query<{ user_phone: string; expires_at: Date }>(
    `SELECT user_phone, expires_at FROM p3_huddle_sessions WHERE token_hash = $1`,
    [hash(secret, "session", token)],
  );
  const row = r.rows[0];
  return row && new Date(row.expires_at).getTime() > nowMs ? row.user_phone : null;
}

export async function endSession(db: Db, secret: string, token: string | undefined): Promise<void> {
  if (token) await db.query(`DELETE FROM p3_huddle_sessions WHERE token_hash = $1`, [hash(secret, "session", token)]);
}
