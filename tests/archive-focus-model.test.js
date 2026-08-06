import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveNoteFocusTargetModel } from "../archive.js";

test("archive note modal close restores the originating row only while it remains connected", () => {
  assert.equal(archiveNoteFocusTargetModel({ origin: "archive-note-7", connected: true }), "archive-note-7");
  assert.equal(archiveNoteFocusTargetModel({ origin: "archive-note-7", connected: false }), null);
  assert.equal(archiveNoteFocusTargetModel({ origin: "", connected: true }), null);
});
