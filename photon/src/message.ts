/**
 * Photon delivers a "public event" whose exact wrapper we confirm during the spike.
 * This finds the message object inside it wherever it lives: the first object
 * that has space.id, sentBy, and id. Update once docs/photon.md records the real shape.
 */
export type InboundMessage = {
  id: string;
  status?: string;
  createdAt?: string;
  sentBy?: { id?: string; kind?: string; handle?: string };
  receivedBy?: { id?: string; kind?: string; handle?: string };
  space: { id: string; kind?: string };
  content?: { type?: string; text?: string; attachmentId?: string; [k: string]: unknown };
};

export function findMessage(node: unknown, depth = 0): InboundMessage | undefined {
  if (!node || typeof node !== "object" || depth > 5) return undefined;
  const o = node as Record<string, any>;
  if (typeof o.id === "string" && o.space?.id && o.sentBy) return o as InboundMessage;
  for (const value of Object.values(o)) {
    const found = findMessage(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** True only for a message a human sent to our agent. Never answer our own messages. */
export function isFromHuman(m: InboundMessage): boolean {
  return m.sentBy?.kind === "human" && m.receivedBy?.kind === "agent" && (m.status ?? "received") === "received";
}

/** Collect any attachment ids in the content (single or grouped). */
export function attachmentIds(m: InboundMessage): string[] {
  const ids: string[] = [];
  const walk = (c: any) => {
    if (!c || typeof c !== "object") return;
    if (typeof c.attachmentId === "string") ids.push(c.attachmentId);
    if (Array.isArray(c.parts)) c.parts.forEach(walk);
  };
  walk(m.content);
  return ids;
}
