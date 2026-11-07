// H1-2: run Card against P1's facts fixture.  npm run card   (needs GEMINI_API_KEY in ../.env)
// Without a key it prints the prompt and the template so you can still see the pipeline.
import { readFileSync } from "node:fs";
import { FactsSnapshot } from "../../contracts/src";
import { buildPrompt, factsFor, speak, template } from "./character";
import { checkMessage } from "./checker";

const path = process.argv[2] ?? new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url);
const facts = FactsSnapshot.parse(JSON.parse(readFileSync(path, "utf8")));
const purchase = facts.recentEvents.find((e) => e.type === "big_purchase");
const situation = purchase
  ? `The user just spent $${purchase.data.amount} at ${purchase.data.merchant} on the credit card. React in character.`
  : "The user asks how the credit card is doing. React in character.";

if (!process.env.GEMINI_API_KEY) {
  console.log("No GEMINI_API_KEY set. Prompt that would be sent:\n");
  console.log(buildPrompt("card", facts, situation, purchase));
  const t = template("card", facts);
  console.log("\nTemplate fallback:", t, "->", checkMessage(t, factsFor("card", facts, purchase)));
  process.exit(0);
}

const runs = Number(process.env.RUNS ?? 5);
let ungrounded = 0;
for (let i = 0; i < runs; i++) {
  const r = await speak("card", facts, situation, { event: purchase });
  ungrounded += checkMessage(r.text, factsFor("card", facts, purchase)).ungrounded.length;
  console.log(`💳 Card: ${r.text}`);
  console.log(`   source=${r.source} ms=${r.ms} attempts=${JSON.stringify(r.attempts.map((a) => a.error ?? a.ungrounded?.map((u) => u.raw)))}`);
}
console.log(`\n${runs} runs, ${ungrounded} ungrounded numbers in sent messages.`);
