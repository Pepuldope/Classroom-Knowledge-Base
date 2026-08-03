import test from "node:test";
import assert from "node:assert/strict";
import { contentFreeTiming } from "../api/kb-route-privacy.js";

test("legacy timing metadata contains only an allow-listed metric and numeric duration", () => {
  const noteMarker = "Algebra private student note body";
  const header = contentFreeTiming(`kb-search;${noteMarker}`, 42);

  assert.equal(header, "kb-search;dur=42");
  assert.doesNotMatch(header, /Algebra|private|student|body/i);
});

test("legacy timing metadata falls back safely for malformed values", () => {
  assert.equal(contentFreeTiming("kb-related;desc=cache", "not-a-duration"), "kb-related;desc=cache;dur=0");
  assert.equal(contentFreeTiming("note-title-from-error", -10), "kb-route;dur=0");
});
