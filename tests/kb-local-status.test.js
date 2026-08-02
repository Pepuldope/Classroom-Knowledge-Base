import test from "node:test";
import assert from "node:assert/strict";
import { kbLocalStatusModel, kbBuildProgressStatusModel } from "../kb-local-status.js";

test("clear transition announces that the local KB is empty and ready to rebuild", () => {
  assert.deepEqual(kbLocalStatusModel("cleared"), {
    message: "Your local knowledge base was cleared and is now empty. Build it again from Google Classroom when ready.",
    tone: "polite",
    focusTarget: "kbBuildBtn",
  });
});

test("in-progress Classroom builds expose an assertive progress announcement without revealing note content", () => {
  assert.deepEqual(kbBuildProgressStatusModel({ message: "Reading course 2", done: 2, total: 5 }), {
    message: "Reading course 2 (2 of 5 courses)",
    tone: "polite",
    live: "polite",
  });
});
