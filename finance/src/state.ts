// Kept at this path because the agents service tests (agents/test/debate.test.ts, followups.test.ts) import the stub
// from here as an in-process finance service. The implementation lives in ./stub/state.ts.
export { StubState } from "./stub/state";
