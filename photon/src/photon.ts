import { Photon } from "@photon-ai/api";
import { env } from "./env.js";

let client: Photon | undefined;
const photon = () =>
  (client ??= new Photon({ headers: { Authorization: `Bearer ${env.apiKey()}` } }));

/** Where to send: taken from an incoming message, never hardcoded. */
export type Target = {
  spaceId: string; // the conversation (message.space.id)
  senderId: string; // the AGENT's user id (message.receivedBy.id)
};

/** Send plain text. idempotencyKey must be stable per logical message (e.g. outbox row id). */
export async function sendText(t: Target, text: string, idempotencyKey: string, parentMessageId?: string) {
  return photon().projects.sendMessage({
    path: { id: env.projectId() },
    headers: { "idempotency-key": idempotencyKey },
    body: {
      spaceId: t.spaceId,
      senderId: t.senderId,
      ...(parentMessageId ? { parentMessageId } : {}),
      content: { type: "text", format: "plain", text },
    },
  });
}

/**
 * Upload an image (PNG/JPEG bytes), then send it as an attachment.
 * Photon's upload is multipart/related with exactly two parts:
 * 1) JSON { contentType, sizeBytes, filename }  2) the file bytes.
 */
export async function sendImage(t: Target, bytes: Uint8Array, contentType: string, idempotencyKey: string, filename = "image.png") {
  const boundary = `huddlr-${Date.now().toString(36)}`;
  const meta = JSON.stringify({ contentType, sizeBytes: bytes.byteLength, filename });
  const enc = new TextEncoder();
  const body = new Blob([
    enc.encode(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    new Uint8Array(bytes),
    enc.encode(`\r\n--${boundary}--\r\n`),
  ]);
  const attachment = await photon().projects.uploadAttachment({
    path: { id: env.projectId() },
    headers: {
      "content-length": String(body.size),
      "content-type": `multipart/related; boundary=${boundary}; type="application/json"`,
      "idempotency-key": `${idempotencyKey}:upload`,
    },
    body,
  });
  return photon().projects.sendMessage({
    path: { id: env.projectId() },
    headers: { "idempotency-key": idempotencyKey },
    body: {
      spaceId: t.spaceId,
      senderId: t.senderId,
      content: { type: "attachment", attachmentId: attachment.id },
    },
  });
}

/** Typing indicator. Returns false instead of throwing if the platform doesn't support it. */
export async function setTyping(t: Target, typing: boolean): Promise<boolean> {
  try {
    await photon().projects.setSpaceTyping({
      path: { id: env.projectId(), spaceId: t.spaceId },
      body: { senderId: t.senderId, typing },
    });
    return true;
  } catch {
    return false;
  }
}

/** Download an inbound attachment (e.g. a photo the user sent). */
export async function downloadAttachment(attachmentId: string): Promise<Blob> {
  return photon().projects.downloadAttachment({
    path: { id: env.projectId(), attachmentId },
  });
}
