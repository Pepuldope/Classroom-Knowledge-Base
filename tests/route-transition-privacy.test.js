import test from "node:test";
import assert from "node:assert/strict";
import { routeTransitionFocusPrivacyModel } from "../kb.js";

test("route-transition focus markers are UI-only and never enter storage or tutor payloads", () => {
  const marker = routeTransitionFocusPrivacyModel("Archive view opened. Focus restored to Archive navigation.");
  assert.deepEqual(marker, {
    storage: null,
    tutor: null,
    text: "Archive view opened. Focus restored to Archive navigation.",
  });
  assert.equal(JSON.stringify(marker.storage), "null");
  assert.equal(JSON.stringify(marker.tutor), "null");
});

test("route-transition privacy model rejects note content from the marker channel", () => {
  const marker = routeTransitionFocusPrivacyModel("Archive view opened. Secret note body");
  assert.equal(marker.text.includes("Secret note body"), false);
  assert.equal(marker.storage, null);
  assert.equal(marker.tutor, null);
});
