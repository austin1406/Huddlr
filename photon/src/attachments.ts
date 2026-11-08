import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { downloadAttachment } from "./photon.js";

const DIR = "data/attachments";
const VALID_ID = /^pho_att_[A-Za-z0-9]+$/;

export type Stored = { path: string; bytes: Uint8Array; mime: string };
type Download = (id: string) => Promise<Blob>;

/**
 * Get an attachment's bytes: from the local cache if we have it, otherwise download it
 * from Photon once and keep a copy in data/attachments/. Returns null for unknown/bad ids.
 */
export async function getAttachment(id: string, download: Download = downloadAttachment): Promise<Stored | null> {
  if (!VALID_ID.test(id)) return null;
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, id);
  if (existsSync(path) && existsSync(`${path}.mime`)) {
    return { path, bytes: new Uint8Array(readFileSync(path)), mime: readFileSync(`${path}.mime`, "utf8") };
  }
  const blob = await download(id);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || sniff(bytes);
  writeFileSync(path, bytes);
  writeFileSync(`${path}.mime`, mime);
  return { path, bytes, mime };
}

/** Download every attachment of an inbound row and record the local paths for P2. */
export async function storeInboundAttachments(db: Db, inboundId: number, ids: string[], download?: Download): Promise<string[]> {
  const paths: string[] = [];
  for (const id of ids) {
    const s = await getAttachment(id, download);
    if (s) paths.push(s.path);
  }
  if (paths.length) await db.query(`UPDATE inbound_messages SET attachment_paths = $2 WHERE id = $1`, [inboundId, paths]);
  return paths;
}

function sniff(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "application/octet-stream";
}
