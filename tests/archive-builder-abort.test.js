import test from "node:test";
import assert from "node:assert/strict";
import { buildArchiveFromClassroom } from "../archive-builder.js";

function responseFor(url) {
  if (url.includes("/courses?")) {
    return { courses: [{ id: "course-1", name: "Algebra" }] };
  }
  if (url.includes("/topics")) return { topic: [] };
  if (url.includes("/courseWork?")) return { courseWork: [] };
  if (url.includes("/courseWorkMaterials")) return { courseWorkMaterials: [] };
  if (url.includes("/announcements")) return { announcements: [] };
  if (url.includes("/studentSubmissions")) return { submissions: [] };
  throw new Error(`unexpected URL: ${url}`);
}

test("an interrupted Classroom build aborts before returning a partial bundle", async () => {
  const controller = new AbortController();
  let calls = 0;
  const gFetch = async (url) => {
    calls += 1;
    const response = responseFor(url);
    if (url.includes("/studentSubmissions")) controller.abort();
    return response;
  };

  await assert.rejects(
    buildArchiveFromClassroom(gFetch, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.ok(calls > 1, "the test must abort after the course list, during course work");
});
