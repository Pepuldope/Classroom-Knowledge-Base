// kb_open_action_test.mjs — TDD gate for the "universal note open action" fix.
//
// Reported bug (ROADMAP §Reported #5): the note modal's only "open" action is
// an Obsidian-only deep link (obsidian://open?path=...). For the school-backup
// vault notes (which carry ONLY a local filesystem path `p`, not a web URL)
// that link points at a file the student can't reach and requires Obsidian.
//
// The fix introduces a pure resolver `resolveNoteOpenAction(note)` that prefers
// a real external source URL ("Open original" in a new tab), then falls back to
// a downloadable .md ("Download note (.md)") for local/vault notes, and returns
// { kind:"none" } when there's nothing to open. Obsidian becomes a clearly
// labelled SECONDARY opt-in, never the primary action for a vault note.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async () => (await import("../kb.js"));

test("external source url yields an 'Open original' external action", async () => {
  const { resolveNoteOpenAction } = await load();
  const a = resolveNoteOpenAction({ url: "https://classroom.google.com/c/123/a/456" });
  assert.equal(a.kind, "external");
  assert.equal(a.label, "Open original");
  assert.equal(a.href, "https://classroom.google.com/c/123/a/456");
});

test("vault note (only a local path) yields a download action, NOT obsidian-primary", async () => {
  const { resolveNoteOpenAction } = await load();
  const p = "/opt/data/school-backup/2025-26/vault/MAT/Note.md";
  const a = resolveNoteOpenAction({ p });
  assert.equal(a.kind, "download");
  assert.equal(a.label, "Download note (.md)");
  assert.equal(a.path, p);
});

test("note with neither url nor path yields no primary action", async () => {
  const { resolveNoteOpenAction } = await load();
  const a = resolveNoteOpenAction({ t: "Untitled", x: "body" });
  assert.equal(a.kind, "none");
});

test("a non-http url string (e.g. obsidian://) is NOT treated as an external open", async () => {
  const { resolveNoteOpenAction } = await load();
  const a = resolveNoteOpenAction({ url: "obsidian://open?path=x" });
  assert.notEqual(a.kind, "external");
});

test("sourceUrl is honoured as the external link when present", async () => {
  const { resolveNoteOpenAction } = await load();
  const a = resolveNoteOpenAction({ sourceUrl: "https://example.com/note", p: "/local/x.md" });
  assert.equal(a.kind, "external");
  assert.equal(a.href, "https://example.com/note");
});
