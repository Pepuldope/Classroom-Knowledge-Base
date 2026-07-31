import test from "node:test";
import assert from "node:assert/strict";
import { kbLocalStatusModel } from "../kb-local-status.js";

test("clear transition announces that the local KB is empty and ready to rebuild", () => {
  assert.deepEqual(kbLocalStatusModel("cleared"), {
    message: "Your local knowledge base was cleared and is now empty. Build it again from Google Classroom when ready.",
    tone: "polite",
  });
});
