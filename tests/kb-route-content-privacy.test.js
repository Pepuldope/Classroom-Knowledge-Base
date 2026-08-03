import test from "node:test";
import assert from "node:assert/strict";

const NOTE_MARKER = "PRIVATE_NOTE_TITLE private snippet /student/path.md";

function request(body) {
  return new Request("https://example.test/api/kb-scrape", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kb-write-token": "test-write-token",
    },
    body: JSON.stringify(body),
  });
}

test("Classroom scrape errors never echo upstream response content", async () => {
  process.env.KB_WRITE_TOKEN = "test-write-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(NOTE_MARKER, { status: 502 });

  try {
    const { default: scrape } = await import("../api/kb-scrape.js");
    const response = await scrape(request({
      source: "classroom",
      authToken: "test-access-token",
      mode: "list",
    }));
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.doesNotMatch(body, /PRIVATE_NOTE_TITLE|private snippet|student\/path\.md/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KB_WRITE_TOKEN;
  }
});

test("Classroom course errors do not echo caller identifiers or upstream content", async () => {
  process.env.KB_WRITE_TOKEN = "test-write-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ courses: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const courseMarker = "PRIVATE_NOTE_TITLE/student/path.md";
  try {
    const { default: scrape } = await import("../api/kb-scrape.js");
    const response = await scrape(request({
      source: "classroom",
      authToken: "test-access-token",
      mode: "course",
      courseId: courseMarker,
    }));
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.doesNotMatch(body, /PRIVATE_NOTE_TITLE|student\/path\.md/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KB_WRITE_TOKEN;
  }
});
