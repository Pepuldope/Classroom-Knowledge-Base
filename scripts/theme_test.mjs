import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTheme, themeAttribute, themeStorageKey } from "../theme.js";

test("normalizes only supported theme choices and defaults to system", () => {
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("system"), "system");
  assert.equal(normalizeTheme("neon"), "system");
  assert.equal(normalizeTheme(null), "system");
});

test("system theme leaves the document attribute unset while explicit themes set it", () => {
  assert.equal(themeAttribute("system"), null);
  assert.equal(themeAttribute("dark"), "dark");
  assert.equal(themeAttribute("light"), "light");
});

test("uses a stable local-only storage key", () => {
  assert.equal(themeStorageKey(), "cwa_theme");
});
