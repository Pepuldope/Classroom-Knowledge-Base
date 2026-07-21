import test from "node:test";
import assert from "node:assert/strict";
import { getTutorRetryPrompt } from "../kb.js";

test("getTutorRetryPrompt returns the latest user prompt without duplicating it", () => {
  assert.equal(
    getTutorRetryPrompt([
      { role: "user", content: "Explain vectors" },
      { role: "assistant", content: "A vector is..." },
      { role: "user", content: "Give me a practice problem" },
    ]),
    "Give me a practice problem"
  );
});

test("getTutorRetryPrompt ignores empty and malformed messages", () => {
  assert.equal(
    getTutorRetryPrompt([
      { role: "user", content: "" },
      { role: "assistant", content: "failed" },
      { role: "system", content: "not a prompt" },
    ]),
    ""
  );
});
