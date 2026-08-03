import test from "node:test";
import assert from "node:assert/strict";
import { buildArchiveFromClassroom } from "../archive-builder.js";

test("resumed Classroom build skips completed courses and completes from the local checkpoint", async () => {
  const checkpoint = {
    courses: [
      { id: "c1", name: "Algebra", creationTime: "2025-09-01T00:00:00Z" },
      { id: "c2", name: "Physics", creationTime: "2025-09-01T00:00:00Z" },
    ],
    courseData: {
      c1: { topics: [], courseWork: [{ id: "a1", title: "Linear equations" }], courseWorkMaterials: [], announcements: [], submissions: [] },
    },
  };
  const calls = [];
  const saved = [];
  const bundle = await buildArchiveFromClassroom(async (url) => {
    calls.push(url);
    if (!url.includes("courses/c2/")) throw new Error(`unexpected fetch: ${url}`);
    if (url.includes("/topics")) return { topic: [] };
    if (url.includes("/courseWork?")) return { courseWork: [{ id: "a2", title: "Motion" }] };
    if (url.includes("/courseWorkMaterials")) return { courseWorkMaterials: [] };
    if (url.includes("/announcements")) return { announcements: [] };
    if (url.includes("/studentSubmissions")) return { submissions: [] };
    throw new Error(`unexpected URL: ${url}`);
  }, { checkpoint, saveCheckpoint: (next) => saved.push(next) });

  assert.equal(calls.some((url) => url.includes("courses/c1/")), false);
  assert.equal(bundle.notes.length, 2);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].courseData.c1.courseWork, checkpoint.courseData.c1.courseWork);
});
