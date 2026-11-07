import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkMessage, extractNumbers } from '../src/checker.js';

const facts = JSON.parse(fs.readFileSync(new URL('./fixtures/facts.sample.json', import.meta.url)));

test('grounded Card message passes', () => {
  const r = checkMessage("That $249.99 BestBuy charge puts me at $2,310.45 at 24.99% APR. Utilization is 46.2%.", facts);
  assert.deepEqual(r.ungrounded, []);
  assert.equal(r.found, 4);
});

test('catches an invented number', () => {
  const r = checkMessage('That charge will cost you $63 in interest this year.', facts);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ungrounded.map((u) => u.raw), ['$63']);
});

test('catches an invented percent and date', () => {
  const r = checkMessage('APR jumps to 29.99% on Nov 20.', facts);
  assert.deepEqual(r.ungrounded.map((u) => u.raw).sort(), ['29.99%', 'Nov 20']);
});

test('allowed formats: rounding, k, commas, dates', () => {
  for (const msg of [
    'Checking has about $842.',
    'Checking has $840 left.',
    'Car loan is $11.5k.',
    'Car loan is $11,480.',
    'Rent is due Nov 12.',
    'Rent is due 11/12.',
    'Checking dips to -$142.83 on November 13th.',
    "You'd be short $143.",
    'Savings covers 0.6 months.',
  ]) assert.equal(checkMessage(msg, facts).ok, true, msg);
});

test('rounding is not a loophole', () => {
  assert.equal(checkMessage('Checking has $850 left.', facts).ok, false);
  assert.equal(checkMessage('Card is at $2.5k.', facts).ok, false);
});

test('small counts are always allowed', () => {
  assert.equal(checkMessage('I have 2 ideas and 3 bills.', facts).ok, true);
});

test('plan numbers count as grounded', () => {
  const plan = [{ destination: 'checking', amount: 150, reason_code: 'cover_shortfall', reason_numbers: { shortfall: 142.83 } }];
  assert.equal(checkMessage('Move $150 from Savings to Checking.', facts, plan).ok, true);
  assert.equal(checkMessage('Move $150 from Savings to Checking.', facts).ok, false);
});

test('extractor does not double count', () => {
  assert.equal(extractNumbers('$1,234.56 and 12% on 11/14').length, 3);
});
