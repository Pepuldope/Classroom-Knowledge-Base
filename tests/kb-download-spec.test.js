import { test } from "node:test";
import assert from "node:assert/strict";
import { noteDownloadSpec, exportDownloadSpec } from "../kb.js";

test("noteDownloadSpec sanitizes unsafe title characters and uses Markdown MIME", () => {
  assert.deepEqual(noteDownloadSpec({ t: 'Math / Week: 1 <draft>' }), {
    filename: "Math - Week- 1 -draft-.md",
    mime: "text/markdown",
  });
});

test("noteDownloadSpec falls back to an explicit safe filename", () => {
  assert.deepEqual(noteDownloadSpec({ t: "///" }), {
    filename: "note.md",
    mime: "text/markdown",
  });
});

test("exportDownloadSpec returns explicit safe filenames and MIME types", () => {
  assert.deepEqual(exportDownloadSpec("json", "2026-08-04"), {
    filename: "classroom-kb-2026-08-04.json",
    mime: "application/json",
  });
  assert.deepEqual(exportDownloadSpec("md", "2026-08-04"), {
    filename: "classroom-kb-2026-08-04.md",
    mime: "text/markdown",
  });
  assert.deepEqual(exportDownloadSpec("csv", "2026-08-04"), {
    filename: "classroom-kb-2026-08-04.csv",
    mime: "text/csv",
  });
});

test("exportDownloadSpec rejects unsupported formats", () => {
  assert.throws(() => exportDownloadSpec("exe", "2026-08-04"), /Unsupported export format/);
});
