// TDD gate for tutor provider/model attribution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTutorAttribution } from "../kb.js";

test("formats provider and model attribution for a completed tutor answer", () => {
  assert.equal(
    formatTutorAttribution("nvidia", "nvidia/llama-3.1-nemotron-ultra-253b-v1"),
    "Answered by nvidia · nvidia/llama-3.1-nemotron-ultra-253b-v1"
  );
});

test("omits attribution when the tutor response does not identify a provider or model", () => {
  assert.equal(formatTutorAttribution("", ""), "");
  assert.equal(formatTutorAttribution(null, "model"), "");
});
