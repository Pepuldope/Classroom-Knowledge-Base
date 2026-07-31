import test from "node:test";
import assert from "node:assert/strict";
import { relatedPreviewAnnouncement } from "../kb-related-status.js";

test("related preview announces cached loading state and ready result", () => {
  assert.deepEqual(relatedPreviewAnnouncement("loading", { cached: true, count: 0 }), {
    role: "status",
    live: "polite",
    text: "Loading related notes from your local cache…",
  });
  assert.deepEqual(relatedPreviewAnnouncement("ready", { cached: true, count: 2 }), {
    role: "status",
    live: "polite",
    text: "2 related notes loaded from your local cache.",
  });
});

test("related preview announces errors without exposing note content", () => {
  assert.deepEqual(relatedPreviewAnnouncement("error", { cached: false, count: 2 }), {
    role: "status",
    live: "polite",
    text: "Related notes still unavailable after 2 attempts. Retry loading related notes.",
  });
});
