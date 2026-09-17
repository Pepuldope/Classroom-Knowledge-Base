import { test } from "node:test";
import assert from "node:assert/strict";
import {
  noteItemKind,
  noteAttachments,
  driveFileId,
  driveDownloadPlan,
  driveMetadataUrl,
  exportSelectionModel,
  selectExportNotes,
  exportCourseOptions,
  exportYearOptions,
  exportFileTree,
  attachmentPath,
  exportDownloadName,
  noteMarkdown,
  safeSegment,
  crc32,
  buildZip,
  buildResultMessage,
} from "../kb-export.js";

const assignment = {
  t: "Quadratic equations worksheet",
  course: "Math",
  y: "2025-2026",
  topic: "Algebra",
  kind: "assignment",
  s: "Solve ten quadratics.",
  p: "2025-2026/vault/Math/Algebra/quadratics",
  x: [
    "Finish every question.",
    "",
    "Teacher materials:",
    "- [Worksheet 3](https://drive.google.com/file/d/1AbcDEFghij_KLM/view)",
    "- [Khan video](https://www.youtube.com/watch?v=abc)",
    "",
    "Due: 2026-03-04",
    "",
    "[Open assignment in Classroom](https://classroom.google.com/c/1/a/2)",
  ].join("\n"),
};

const material = {
  t: "Formula sheet",
  course: "Math",
  y: "2025-2026",
  topic: "Algebra",
  kind: "material",
  p: "2025-2026/vault/Math/Algebra/formula-sheet",
  x: [
    "Teacher materials:",
    "- [Formulas](https://docs.google.com/document/d/2DocIdValue99/edit)",
    "",
    "[Open in Classroom](https://classroom.google.com/c/1/m/3)",
  ].join("\n"),
};

const announcement = {
  t: "Math - Announcements",
  course: "Math",
  y: "2025-2026",
  kind: "announcements",
  p: "2025-2026/vault/Math/announcements",
  x: "## 2026-02-01\n\nNo lesson on Friday.",
};

const bundle = {
  courses: [{ name: "Math" }, { name: "Biology" }],
  notes: [assignment, material, announcement, { t: "Cells", course: "Biology", y: "2024-2025", kind: "material", x: "" }],
};

// --- what a note is -------------------------------------------------------

test("noteItemKind trusts a declared kind and normalises announcements", () => {
  assert.equal(noteItemKind(assignment), "assignment");
  assert.equal(noteItemKind(material), "material");
  assert.equal(noteItemKind(announcement), "announcement");
});

test("noteItemKind reads a legacy kind:'note' body rather than forcing a rebuild", () => {
  assert.equal(noteItemKind({ kind: "note", x: "Some text\n\nDue: 2026-01-01" }), "assignment");
  assert.equal(noteItemKind({ kind: "note", x: "Notes\n\nMax points: 20" }), "assignment");
  assert.equal(noteItemKind({ kind: "note", x: "Just a handout link." }), "material");
});

// --- attachments ----------------------------------------------------------

test("noteAttachments returns each attachment once and skips the Classroom back-link", () => {
  assert.deepEqual(noteAttachments(assignment), [
    {
      title: "Worksheet 3",
      url: "https://drive.google.com/file/d/1AbcDEFghij_KLM/view",
      source: "drive",
      driveId: "1AbcDEFghij_KLM",
    },
    { title: "Khan video", url: "https://www.youtube.com/watch?v=abc", source: "youtube", driveId: null },
  ]);
});

test("driveFileId handles the /d/ and ?id= URL shapes, and gives up on others", () => {
  assert.equal(driveFileId("https://drive.google.com/file/d/1AbcDEFghij_KLM/view"), "1AbcDEFghij_KLM");
  assert.equal(driveFileId("https://drive.google.com/open?id=1AbcDEFghij_KLM"), "1AbcDEFghij_KLM");
  assert.equal(driveFileId("https://example.com/handout.pdf"), null);
});

test("driveDownloadPlan exports Workspace docs and streams everything else", () => {
  assert.deepEqual(driveDownloadPlan({ id: "X1", name: "Notes", mimeType: "application/vnd.google-apps.document" }), {
    url: "https://www.googleapis.com/drive/v3/files/X1/export?mimeType=application%2Fpdf",
    filename: "Notes.pdf",
    mime: "application/pdf",
  });
  assert.deepEqual(driveDownloadPlan({ id: "X2", name: "Sheet1", mimeType: "application/vnd.google-apps.spreadsheet" }).filename, "Sheet1.xlsx");
  assert.deepEqual(driveDownloadPlan({ id: "X3", name: "handout.pdf", mimeType: "application/pdf" }), {
    url: "https://www.googleapis.com/drive/v3/files/X3?alt=media&supportsAllDrives=true",
    filename: "handout.pdf",
    mime: "application/pdf",
  });
});

test("driveDownloadPlan refuses things with no bytes", () => {
  assert.equal(driveDownloadPlan({ id: "F", mimeType: "application/vnd.google-apps.folder" }), null);
  assert.equal(driveDownloadPlan({ id: "Q", mimeType: "application/vnd.google-apps.form" }), null);
  assert.equal(driveDownloadPlan({}), null);
});

test("driveMetadataUrl asks for exactly the fields the plan needs", () => {
  assert.match(driveMetadataUrl("A B"), /files\/A%20B\?fields=id,name,mimeType,size/);
});

// --- selection ------------------------------------------------------------

test("exportSelectionModel treats no ticked type as every type", () => {
  assert.deepEqual(exportSelectionModel({}).kinds, ["assignment", "material", "announcement"]);
  assert.deepEqual(exportSelectionModel({ kinds: ["material", "nope"] }).kinds, ["material"]);
  assert.equal(exportSelectionModel({ format: "exe" }).format, "zip");
  assert.equal(exportSelectionModel({ attachments: "yes" }).attachments, false);
});

test("selectExportNotes narrows by class, year and type together", () => {
  assert.equal(selectExportNotes(bundle, { courses: ["Math"] }).length, 3);
  assert.equal(selectExportNotes(bundle, { courses: ["Math"], kinds: ["material"] }).length, 1);
  assert.equal(selectExportNotes(bundle, { years: ["2024-2025"] }).length, 1);
  assert.equal(selectExportNotes(bundle, { courses: ["Math"], years: ["2024-2025"] }).length, 0);
  assert.equal(selectExportNotes(bundle, {}).length, 4); // no filter = everything
});

test("exportCourseOptions counts what each class would actually yield", () => {
  const options = exportCourseOptions(bundle);
  assert.deepEqual(options.map((o) => o.name), ["Biology", "Math"]);
  const math = options.find((o) => o.name === "Math");
  assert.deepEqual(math.counts, { assignment: 1, material: 1, announcement: 1 });
  assert.deepEqual(math.years, ["2025-2026"]);
});

test("exportCourseOptions keeps a course that has no notes yet", () => {
  const options = exportCourseOptions({ courses: [{ name: "Empty class" }], notes: [] });
  assert.deepEqual(options, [{ name: "Empty class", years: [], noteCount: 0, counts: { assignment: 0, material: 0, announcement: 0 } }]);
});

test("exportYearOptions lists every year in the corpus, sorted", () => {
  assert.deepEqual(exportYearOptions(bundle), ["2024-2025", "2025-2026"]);
});

// --- the file tree --------------------------------------------------------

test("safeSegment strips path separators without emptying the name", () => {
  assert.equal(safeSegment("Math / Week: 1"), "Math - Week- 1");
  assert.equal(safeSegment("///"), "untitled");
  assert.equal(safeSegment("", "note"), "note");
});

test("noteMarkdown keeps the metadata a standalone file loses", () => {
  const md = noteMarkdown(assignment);
  assert.match(md, /^# Quadratic equations worksheet/);
  assert.match(md, /\*\*Class:\*\* Math/);
  assert.match(md, /\*\*Type:\*\* Assignment/);
  assert.match(md, /> Solve ten quadratics\./);
  assert.match(md, /Finish every question\./);
});

test("exportFileTree writes one file per note, foldered by class and type", () => {
  const { files, index } = exportFileTree([assignment, material, announcement]);
  assert.deepEqual(files.map((f) => f.path), [
    "Math/Assignments/Algebra/Quadratic equations worksheet.md",
    "Math/Materials/Algebra/Formula sheet.md",
    "Math/Announcements/Math - Announcements.md",
  ]);
  assert.match(index, /## Math/);
  assert.match(index, /### Assignments/);
});

test("exportFileTree never collides two notes onto one path", () => {
  const dup = { ...material, p: "other" };
  const { files } = exportFileTree([material, dup]);
  assert.equal(new Set(files.map((f) => f.path)).size, 2);
  assert.match(files[1].path, /\(2\)\.md$/);
});

test("exportFileTree lists downloaded attachments under their note", () => {
  const byNote = new Map([[assignment.p, [{ title: "Worksheet 3", path: "Math/Assignments/Attachments/Quadratic equations worksheet/Worksheet 3.pdf" }]]]);
  const { index } = exportFileTree([assignment], { attachmentsByNotePath: byNote });
  assert.match(index, /📎 \[Worksheet 3\]/);
});

test("attachmentPath parks a file beside its note and de-duplicates", () => {
  const used = new Set();
  assert.equal(
    attachmentPath(assignment, "Worksheet 3.pdf", used),
    "Math/Assignments/Attachments/Quadratic equations worksheet/Worksheet 3.pdf",
  );
  assert.match(attachmentPath(assignment, "Worksheet 3.pdf", used), /\(2\)\.pdf$/);
});

test("exportDownloadName names the file after what was picked", () => {
  assert.equal(exportDownloadName({ courses: ["Math"], format: "zip" }, "2026-09-17"), "Math-2026-09-17.zip");
  assert.equal(exportDownloadName({ courses: ["Math", "Biology"], format: "zip" }, "2026-09-17"), "2-classes-2026-09-17.zip");
  assert.equal(exportDownloadName({ format: "csv" }, "2026-09-17"), "classroom-kb-2026-09-17.csv");
});

// --- the zip writer -------------------------------------------------------

test("crc32 matches the known PKZIP check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("buildZip produces a readable stored archive", () => {
  const zip = buildZip([{ path: "a/b.md", text: "hello" }], { date: new Date("2026-09-17T10:00:00Z") });
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50); // local header
  assert.equal(view.getUint16(8, true), 0); // stored, not deflated
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800); // UTF-8 names
  const nameLen = view.getUint16(26, true);
  assert.equal(new TextDecoder().decode(zip.slice(30, 30 + nameLen)), "a/b.md");
  assert.equal(new TextDecoder().decode(zip.slice(30 + nameLen, 30 + nameLen + 5)), "hello");
  // End-of-central-directory sits last and counts the entries.
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 1);
});

test("buildZip round-trips through the system unzip (see scripts/zip_roundtrip_test.mjs)", () => {
  // Structural check here; byte-level verification against a real unzip lives in
  // that gate so this file stays dependency-free.
  const zip = buildZip([{ path: "one.md", text: "1" }, { path: "two.md", text: "22" }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
});

// --- the rebuild result line ---------------------------------------------

test("buildResultMessage says 'already up to date' when nothing changed", () => {
  assert.match(buildResultMessage({ before: 812, after: 812 }), /Already up to date/);
});

test("buildResultMessage counts what a rebuild actually added or removed", () => {
  assert.match(buildResultMessage({ before: 800, after: 812 }), /12 new notes/);
  assert.match(buildResultMessage({ before: 812, after: 812, removed: 3 }), /3 new notes.*3 removed/);
  assert.match(buildResultMessage({ before: 811, after: 812 }), /1 new note\b/);
});

test("buildResultMessage does not claim success over an empty corpus", () => {
  assert.equal(buildResultMessage({ before: 0, after: 0 }), "Nothing found in Classroom yet.");
});
