import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTutorRetrievedNotes } from "../kb-tutor-context.js";

test("buildTutorRetrievedNotes sends only the bounded notes selected by retrieval", () => {
  const bundle = {
    notes: [
      { t: "Algebra", x: "private algebra body", course: "Math" },
      { t: "History", x: "private history body", course: "History" },
      { t: "Biology", x: "private biology body", course: "Science" },
    ],
  };

  const selected = buildTutorRetrievedNotes(bundle, "algebra", { limit: 1 });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].t, "Algebra");
  assert.equal(selected[0].x, "private algebra body");
  assert.equal(selected.some((note) => note.t === "History"), false);
  assert.equal(selected.some((note) => note.t === "Biology"), false);
});
