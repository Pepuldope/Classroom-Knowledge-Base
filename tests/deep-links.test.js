import test from "node:test";
import assert from "node:assert/strict";
import { noteHref, assignmentHref, parseDeepLink, wantsNewTab } from "../deep-links.js";

test("a note's key and an assignment's id round-trip through their address", () => {
  const key = "ELA Y4 Omega|2026-27|Adjectives - Synonyms|SPRINT 1";
  assert.deepEqual(parseDeepLink(noteHref(key)), { type: "note", key });
  assert.deepEqual(parseDeepLink(assignmentHref("812 34/x")), { type: "assignment", id: "812 34/x" });
  assert.equal(noteHref(""), "");
});

test("anything that is not one of ours is ignored, including an OAuth redirect", () => {
  assert.equal(parseDeepLink("#access_token=abc&state=xyz"), null);
  assert.equal(parseDeepLink("#note="), null);
  assert.equal(parseDeepLink("#note=%E0%A4%A"), null, "malformed escapes must not throw");
  assert.equal(parseDeepLink(""), null);
});

test("middle-click and Ctrl/⌘/Shift-click want a new tab; a plain click does not", () => {
  assert.equal(wantsNewTab({ type: "auxclick", button: 1 }), true);
  assert.equal(wantsNewTab({ type: "auxclick", button: 2 }), false, "right-click is the context menu");
  assert.equal(wantsNewTab({ type: "click", button: 0, ctrlKey: true }), true);
  assert.equal(wantsNewTab({ type: "click", button: 0, metaKey: true }), true);
  assert.equal(wantsNewTab({ type: "click", button: 0 }), false);
});
