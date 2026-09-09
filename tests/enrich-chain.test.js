// Walking the model chain: what counts as an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { firstParsableAnswer, parseModelJson } from "../api/enrich.js";

const chain = ["a", "b", "c"];
const parse = parseModelJson;

test("the first model that returns a usable object wins", async () => {
  const asked = [];
  const result = await firstParsableAnswer(chain, {
    call: async (m) => { asked.push(m); return '{"taskKind":"Essay"}'; },
    parse,
  });
  assert.deepEqual(asked, ["a"], "no reason to ask anyone else");
  assert.equal(result.model, "a");
  assert.deepEqual(result.value, { taskKind: "Essay" });
});

test("prose is not an answer — the chain carries on", async () => {
  // The reported failure: a reasoning model narrating in the content channel.
  // "We need to output JSON with fields weight, actionType…" used to END the
  // chain, on behalf of every model after it that was never asked.
  const asked = [];
  const unparsable = [];
  const result = await firstParsableAnswer(chain, {
    call: async (model) => {
      asked.push(model);
      return model === "a"
        ? "We need to output JSON with fields weight, actionType, taskKind"
        : '{"taskKind":"Presentation"}';
    },
    parse,
    onUnparsable: (model, raw) => unparsable.push(`${model}:${raw.slice(0, 12)}`),
  });
  assert.deepEqual(asked, ["a", "b"], "the prose model must not end the chain");
  assert.equal(result.model, "b");
  assert.deepEqual(unparsable, ["a:We need to o"], "and its failure is still reported");
});

test("an object embedded in a preamble is salvaged rather than skipped", async () => {
  const result = await firstParsableAnswer(chain, {
    call: async () => 'Let me think about this.\n```json\n{"taskKind":"Essay","estimatedMinutes":30}\n```',
    parse,
  });
  assert.equal(result.model, "a");
  assert.equal(result.value.estimatedMinutes, 30);
});

test("a null answer is skipped without being called unparsable", async () => {
  const unparsable = [];
  const result = await firstParsableAnswer(chain, {
    call: async (model) => (model === "a" ? null : '{"ok":true}'),
    parse,
    onUnparsable: (m) => unparsable.push(m),
  });
  assert.equal(result.model, "b");
  assert.deepEqual(unparsable, [], "an HTTP failure is reported by callModel, not here");
});

test("an account-level stop closes every remaining door", async () => {
  const asked = [];
  let exhausted = false;
  const result = await firstParsableAnswer(chain, {
    call: async (model) => { asked.push(model); exhausted = true; return null; },
    parse,
    stop: () => exhausted,
  });
  assert.equal(result, null);
  assert.deepEqual(asked, ["a"], "no point asking four more models on a spent quota");
});

test("a non-object JSON answer does not count", async () => {
  // A model that replies `"Essay"` or `[1,2]` has technically returned JSON and
  // has still not done the job.
  const asked = [];
  const result = await firstParsableAnswer(chain, {
    call: async (model) => { asked.push(model); return model === "c" ? '{"ok":true}' : '["Essay"]'; },
    parse,
  });
  assert.deepEqual(asked, ["a", "b", "c"]);
  assert.deepEqual(result.value, { ok: true });
});

test("every model failing returns null rather than throwing", async () => {
  assert.equal(await firstParsableAnswer(chain, { call: async () => null, parse }), null);
  assert.equal(await firstParsableAnswer([], { call: async () => '{"a":1}', parse }), null);
  assert.equal(await firstParsableAnswer(null, { call: async () => '{"a":1}', parse }), null);
});
