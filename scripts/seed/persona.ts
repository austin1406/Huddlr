// Loads and validates contracts/persona.json with P1's zod schema.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Persona } from "../../contracts/src/persona";

export { Persona };

const CONTRACT = fileURLToPath(new URL("../../contracts/persona.json", import.meta.url));

export function loadPersona(): Persona {
  return Persona.parse(JSON.parse(readFileSync(CONTRACT, "utf8")));
}
