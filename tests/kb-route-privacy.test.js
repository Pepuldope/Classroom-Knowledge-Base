import test from "node:test";
import assert from "node:assert/strict";
import { contentFreeTiming } from "../api/kb-route-privacy.js";
import routerHealth from "../api/router-health.js";

test("legacy timing metadata contains only an allow-listed metric and numeric duration", () => {
  const noteMarker = "Algebra private student note body";
  const header = contentFreeTiming(`kb-search;${noteMarker}`, 42);

  assert.equal(header, "kb-search;dur=42");
  assert.doesNotMatch(header, /Algebra|private|student|body/i);
});

test("legacy timing metadata falls back safely for malformed values", () => {
  assert.equal(contentFreeTiming("kb-related;desc=cache", "not-a-duration"), "kb-related;desc=cache;dur=0");
  assert.equal(contentFreeTiming("note-title-from-error", -10), "kb-route;dur=0");
});

test("router health GET returns JSON metrics without exposing note content", async () => {
  const response = await routerHealth(new Request("https://example.test/api/router-health"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(typeof body.selections, "number");
  assert.equal(typeof body.fallbackRate, "number");
  assert.ok(Array.isArray(body.health));
  assert.ok(Array.isArray(body.unhealthy));
  assert.ok(Array.isArray(body.recentRoutes));
});

test("router health reset clears counters without adding a debug note", async () => {
  const response = await routerHealth(new Request("https://example.test/api/router-health?reset=1"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.selections, 0);
  assert.equal(body.fallbacks, 0);
  assert.equal(body.recentRoutes.length, 0);
  assert.equal(Object.hasOwn(body, "_note"), false);
});
