// GPT writes the characters' lines when OPENAI_API_KEY is set; Gemini answers if GPT fails. The network is faked:
// these tests never call OpenAI or Gemini for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FactsSnapshot } from "../../contracts/src";
import { speak, usingOpenAI } from "../src/character";

const facts = FactsSnapshot.parse(JSON.parse(readFileSync(new URL("../../contracts/fixtures/facts.fixture.json", import.meta.url), "utf8")));
const realFetch = globalThis.fetch;

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    globalThis.fetch = realFetch;
  });
}

const openaiReply = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
const geminiReply = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

test("GPT is used when OPENAI_API_KEY is set; CHARACTER_PROVIDER=gemini switches back", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test", CHARACTER_PROVIDER: undefined }, async () => assert.equal(usingOpenAI(), true));
  await withEnv({ OPENAI_API_KEY: "sk-test", CHARACTER_PROVIDER: "gemini" }, async () => assert.equal(usingOpenAI(), false));
  await withEnv({ OPENAI_API_KEY: undefined }, async () => assert.equal(usingOpenAI(), false));
});

test("a character's line comes from GPT (gpt-5.4-mini, no hidden thinking), through the same checks", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  await withEnv({ OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "g-test", CHARACTER_PROVIDER: undefined, OPENAI_MODEL: undefined }, async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return openaiReply("Your savings is at $900.00, about 2 weeks of must-pay bills.");
    }) as typeof fetch;
    const r = await speak("savings", facts, "The user asked how savings is doing.", { deadline: Date.now() + 5000 });
    assert.equal(r.source, "model");
    assert.match(r.text, /\$900\.00/);
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.openai\.com\/v1\/chat\/completions/);
  assert.equal(calls[0].body.model, "gpt-5.4-mini");
  assert.equal(calls[0].body.reasoning_effort, "none");
});

test("GPT down: Gemini answers instead; a made-up number from GPT is still rejected", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "g-test", CHARACTER_PROVIDER: undefined }, async () => {
    const hits: string[] = [];
    globalThis.fetch = (async (url: string) => {
      hits.push(String(url));
      return String(url).includes("openai") ? new Response("rate limited", { status: 429 }) : geminiReply("Your savings is at $900.00.");
    }) as typeof fetch;
    const r = await speak("savings", facts, "How is savings?", { deadline: Date.now() + 5000 });
    assert.equal(r.text, "Your savings is at $900.00.");
    assert.ok(hits[0].includes("openai") && hits[1].includes("googleapis"), "tried GPT, then Gemini");

    globalThis.fetch = (async () => openaiReply("You have $9,999.99 saved!")) as typeof fetch;
    const lie = await speak("savings", facts, "How is savings?", { deadline: Date.now() + 5000 });
    assert.doesNotMatch(lie.text, /9,999/, "the number checker applies to GPT too");
  });
});
