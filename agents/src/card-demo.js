// H1-2: run Card against the facts fixture.  npm run card   (needs GEMINI_API_KEY in ../.env)
// Without a key it prints the prompt and the template so you can still see the pipeline.
import fs from 'node:fs';
import { speak, buildPrompt, template } from './character.js';
import { checkMessage } from './checker.js';

const factsPath = process.argv[2] ?? new URL('../test/fixtures/facts.sample.json', import.meta.url);
const facts = JSON.parse(fs.readFileSync(factsPath));
const situation = 'The user just bought something for $249.99 at BestBuy on the credit card. React in character.';

if (!process.env.GEMINI_API_KEY) {
  console.log('No GEMINI_API_KEY set. Prompt that would be sent:\n');
  console.log(buildPrompt('card', facts, situation));
  console.log('\nTemplate fallback:', template('card', facts), '->', checkMessage(template('card', facts), facts));
  process.exit(0);
}

const runs = Number(process.env.RUNS ?? 5);
let ungrounded = 0;
for (let i = 0; i < runs; i++) {
  const r = await speak('card', facts, situation);
  const final = checkMessage(r.text, facts);
  ungrounded += final.ungrounded.length;
  console.log(`💳 Card: ${r.text}`);
  console.log(`   source=${r.source} ms=${r.ms} attempts=${JSON.stringify(r.attempts.map((a) => a.error ?? a.ungrounded.map((u) => u.raw)))}`);
}
console.log(`\n${runs} runs, ${ungrounded} ungrounded numbers in sent messages.`);
