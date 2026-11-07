// Gate 0 local harness: one event -> moderator -> characters in parallel -> checker -> printed as the user would see it.
//
//   npm run harness                                  big_purchase on the normal fixture, real Gemini
//   npm run harness -- --event forecast_problem --fixture shortfall
//   npm run harness -- --fake                        no key needed: fake model invents "$63" once, to show the checker
//   npm run harness -- --runs 10                     repeat and total the ungrounded numbers
//
// Messages print in the order they finish (that's how they'd be sent). Nothing is written to a database yet.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { EventType, FactsSnapshot, FinanceEvent, Plan, type CharacterId } from "../../contracts/src";
import { character, factsFor, speak, template } from "./character";
import { checkMessage } from "./checker";
import { decide } from "./moderator";

const { values: args } = parseArgs({
  options: {
    event: { type: "string", default: "big_purchase" },
    fixture: { type: "string", default: "normal" },
    fake: { type: "boolean", default: false },
    runs: { type: "string", default: "1" },
    demo: { type: "boolean", default: true },
  },
});

const load = (rel: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${rel}`, import.meta.url), "utf8"));
const facts = FactsSnapshot.parse(load(args.fixture === "shortfall" ? "facts.shortfall.fixture.json" : "facts.fixture.json"));
const plan = Plan.parse(load("plan.fixture.json"));
const eventType = EventType.parse(args.event);
const event =
  facts.recentEvents.find((e) => e.type === eventType) ??
  FinanceEvent.array().parse(load("events.fixture.json")).find((e) => e.type === eventType)!;

const useFake = args.fake || !process.env.GEMINI_API_KEY;
if (useFake && !args.fake) console.log("(no GEMINI_API_KEY, using the fake model)\n");

/** Fake model: invents a number on the first try so you can watch the checker catch it, behaves on retry. */
const fakeFor = (id: CharacterId) => {
  let calls = 0;
  return async () => (calls++ === 0 ? `${template(id, facts, plan)} That's $63 you'll never see again.` : template(id, facts, plan));
};

const situation = (id: CharacterId) =>
  id === "coach"
    ? `The accounts just reacted to this event: ${event.type}. Settle it with the plan.`
    : `This just happened: ${event.type} ${JSON.stringify(event.data)}. React in character, from your account's point of view.`;

const runs = Number(args.runs);
let totalUngrounded = 0;
for (let run = 1; run <= runs; run++) {
  const decision = decide(event, {
    now: new Date(facts.asOf), timezone: facts.timezone, demoMode: args.demo, proactiveSentToday: 0, alreadyHandled: false, facts,
  });
  console.log(`— run ${run}: ${event.type} → ${decision.action} (${decision.reason})`);
  if (decision.action !== "react") continue;

  const started = Date.now(); // real clock: latency metric
  let first: number | null = null;
  await Promise.all(
    decision.speakers.map(async (id) => {
      const r = await speak(id, facts, situation(id), {
        event,
        plan: id === "coach" ? plan : null,
        deadline: started + (id === "coach" ? 15_000 : 5_000),
        ...(useFake ? { model: fakeFor(id) } : {}),
      });
      first ??= Date.now() - started;
      const final = checkMessage(r.text, factsFor(id, facts, event), ...(id === "coach" ? [plan] : []));
      totalUngrounded += final.ungrounded.length;
      const c = character(id);
      const caught = r.attempts.flatMap((a) => a.ungrounded?.map((u) => u.raw) ?? (a.error ? [`error: ${a.error}`] : []));
      console.log(`${c.emoji} ${c.name}: ${r.text}`);
      console.log(`   [${r.source}, ${r.ms} ms${caught.length ? `, caught: ${caught.join(", ")}` : ""}]`);
    }),
  );
  console.log(`   first message ${first} ms, all done ${Date.now() - started} ms\n`);
}
console.log(`${runs} run(s): ${totalUngrounded} ungrounded numbers in messages that would be sent.`);
process.exitCode = totalUngrounded === 0 ? 0 : 1;
