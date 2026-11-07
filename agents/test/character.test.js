import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { speak, template, cast } from '../src/character.js';
import { checkMessage } from '../src/checker.js';

const facts = JSON.parse(fs.readFileSync(new URL('./fixtures/facts.sample.json', import.meta.url)));
const fake = (...replies) => { let i = 0; return async () => replies[Math.min(i++, replies.length - 1)]; };
const far = () => Date.now() + 60_000;

test('grounded reply is sent as-is', async () => {
  const r = await speak('card', facts, 'x', { model: fake('That puts me at $2,310.45 at 24.99% APR.'), deadline: far() });
  assert.equal(r.source, 'model');
});

test('invented number triggers a retry, retry fixes it', async () => {
  const r = await speak('card', facts, 'x', {
    model: fake('That will cost you $63 in interest.', 'That adds to my $2,310.45 balance at 24.99%.'),
    deadline: far(),
  });
  assert.equal(r.source, 'retry');
  assert.deepEqual(r.attempts[0].ungrounded.map((u) => u.raw), ['$63']);
});

test('invented number twice falls back to the template', async () => {
  const r = await speak('card', facts, 'x', { model: fake('$63 of interest!', 'Still $63.'), deadline: far() });
  assert.equal(r.source, 'template');
  assert.equal(checkMessage(r.text, facts).ok, true);
});

test('no time left: skip the retry, use the template', async () => {
  const r = await speak('card', facts, 'x', { model: fake('$63 of interest!'), deadline: Date.now() + 1000 });
  assert.equal(r.source, 'template');
  assert.equal(r.attempts.length, 1);
});

test('model error falls back to the template', async () => {
  const r = await speak('card', facts, 'x', { model: async () => { throw new Error('503'); }, deadline: far() });
  assert.equal(r.source, 'template');
});

test('every template is grounded', () => {
  for (const c of cast) assert.equal(checkMessage(template(c.id, facts), facts).ok, true, c.id);
});
