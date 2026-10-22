// The whole request has one time budget, because Vercel kills an Edge function
// that has not started answering in 25s — and kills ALL of it. Seen on
// 2026-10-22: four POST /api/enrich in a row stopped at 25s, so five
// assignments failed together, including the ones that already had an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { requestBudget, withTimeout, firstParsableAnswer, parseModelJson } from "../api/enrich.js";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("a budget counts down from when it was made", () => {
  const clock = fakeClock(1000);
  const budget = requestBudget(20_000, clock.now);
  assert.equal(budget.remaining(), 20_000);
  clock.advance(5_000);
  assert.equal(budget.remaining(), 15_000);
  clock.advance(30_000);
  assert.equal(budget.remaining(), 0, "never negative");
});

test("one call gets its cap, but never more than what is left", () => {
  const clock = fakeClock();
  const budget = requestBudget(20_000, clock.now);
  assert.equal(budget.slice(8_000), 8_000);
  clock.advance(16_000);
  assert.equal(budget.slice(8_000), 4_000, "a late call is cut to the deadline");
  clock.advance(10_000);
  assert.equal(budget.slice(8_000), 0);
});

test("withTimeout passes an answer through untouched", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 1_000, "x"), "ok");
});

test("withTimeout gives up on a call that never answers, and says which", async () => {
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 10, "router"), /router: no answer in/);
});

test("withTimeout with no time left fails at once instead of waiting", async () => {
  const started = Date.now();
  await assert.rejects(withTimeout(new Promise(() => {}), 0, "router"));
  assert.ok(Date.now() - started < 50);
});

test("the chain stops asking models once the budget is spent", async () => {
  // Each link is slow; after two the request is out of time. Asking the third
  // and fourth is what pushed the response past 25s.
  const clock = fakeClock();
  const budget = requestBudget(20_000, clock.now);
  const asked = [];
  const result = await firstParsableAnswer(["a", "b", "c", "d"], {
    call: async (m) => { asked.push(m); clock.advance(9_000); return null; },
    parse: parseModelJson,
    stop: () => budget.remaining() < 3_000,
  });
  assert.equal(result, null);
  assert.deepEqual(asked, ["a", "b"], "2s left after b — not enough to start c");
});
