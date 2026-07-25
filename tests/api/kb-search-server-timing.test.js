import { test } from "node:test";
import assert from "node:assert/strict";
import kbSearch from "../../api/kb-search.js";
import kbRelated from "../../api/kb-related.js";

function makeReq(url, method = "GET") {
  return new Request("http://localhost" + url, { method });
}

test("/api/kb-search includes Server-Timing header with duration", async () => {
  const resp = await kbSearch(makeReq("/api/kb-search?q=test&limit=1"));
  assert.equal(resp.status, 200);
  const timing = resp.headers.get("Server-Timing");
  assert.ok(
    timing && /kb-search;dur=\d+/.test(timing),
    `Expected Server-Timing header like 'kb-search;dur=123', got ${timing}`
  );
});

test("/api/kb-search includes a platform-survivable timing header", async () => {
  const resp = await kbSearch(makeReq("/api/kb-search?q=test&limit=1"));
  assert.match(resp.headers.get("X-Server-Timing") || "", /^kb-search;dur=\d+$/);
});

test("/api/kb-search includes Server-Timing on validation errors", async () => {
  const resp = await kbSearch(makeReq("/api/kb-search"));
  assert.equal(resp.status, 400);
  assert.match(resp.headers.get("Server-Timing") || "", /^kb-search;dur=\d+$/);
});

test("/api/kb-related includes Server-Timing on validation errors", async () => {
  const resp = await kbRelated(makeReq("/api/kb-related"));
  assert.equal(resp.status, 400);
  assert.match(resp.headers.get("Server-Timing") || "", /^kb-related;dur=\d+$/);
});
