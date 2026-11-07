import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Character = { id: string; name: string; emoji: string };
const cast: Character[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../contracts/cast.json", import.meta.url)), "utf8"),
).characters;

/** "<emoji> <Name>: <text>" for a cast member; plain text for "system" or unknown speakers. */
export function formatMessage(speaker: string, text: string): string {
  const c = cast.find((x) => x.id === speaker);
  return c ? `${c.emoji} ${c.name}: ${text}` : text;
}
