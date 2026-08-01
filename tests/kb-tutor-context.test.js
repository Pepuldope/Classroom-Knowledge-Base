import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTutorRetrievedNotes, tutorRequestNotesModel } from "../kb-tutor-context.js";

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

test("tutorRequestNotesModel keeps a many-match tutor payload under the browser budget", () => {
  const huge = "student note body ".repeat(5000);
  const bundle = {
    notes: Array.from({ length: 40 }, (_, index) => ({
      t: `Algebra lesson ${index}`,
      course: "Math",
      topic: "Quadratic equations",
      s: huge,
      x: huge,
    })),
  };

  const retrieved = buildTutorRetrievedNotes(bundle, "algebra quadratic", { limit: 40 });
  const notes = tutorRequestNotesModel(retrieved);
  const serialized = JSON.stringify({ messages: [{ role: "user", content: "Explain algebra" }], notes });

  assert.equal(notes.length, 8);
  assert.ok(serialized.length <= 24000, `payload was ${serialized.length} chars`);
  assert.ok(notes.every((note) => note.x.length <= 1400 && note.s.length <= 1400));
  assert.ok(notes.every((note) => !Object.hasOwn(note, "p")));
});
