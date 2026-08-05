import test from "node:test";
import assert from "node:assert/strict";
import { pinnedNotesModel, togglePinnedNote } from "../kb.js";

test("pinnedNotesModel keeps only bounded note identifiers and titles", () => {
  assert.deepEqual(pinnedNotesModel([
    { id: " math|2025|Algebra ", title: "  Algebra  " },
    { id: "", title: "ignored" },
    { id: "history|2025|Essay", title: "" },
    { id: "math|2025|Algebra", title: "Duplicate" },
  ]), [
    { id: "math|2025|Algebra", title: "Algebra" },
  ]);
});

test("togglePinnedNote adds and removes one local note without storing its body", () => {
  const note = { id: "math|2025|Algebra", title: "Algebra", x: "private body" };
  const added = togglePinnedNote([], note);
  assert.deepEqual(added, [{ id: "math|2025|Algebra", title: "Algebra" }]);
  assert.deepEqual(togglePinnedNote(added, note), []);
});
