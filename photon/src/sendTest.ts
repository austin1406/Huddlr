/**
 * Spike B helper: send a text and an image to a conversation.
 * Usage: npx tsx src/sendTest.ts <spaceId> <agentUserId> [path/to/image.png]
 * Get both ids from data/events.jsonl (message.space.id and message.receivedBy.id).
 */
import { readFileSync } from "node:fs";
import { sendImage, sendText } from "./photon.js";

const [spaceId, senderId, imagePath] = process.argv.slice(2);
if (!spaceId || !senderId) {
  console.error("Usage: npx tsx src/sendTest.ts <spaceId> <agentUserId> [image.png]");
  process.exit(1);
}
const target = { spaceId, senderId };
const run = Date.now();

await sendText(target, "💳 Card: test message from the outbox spike.", `test-text:${run}`);
console.log("text accepted");

if (imagePath) {
  const type = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  await sendImage(target, readFileSync(imagePath), type, `test-image:${run}`);
  console.log("image accepted");
}
