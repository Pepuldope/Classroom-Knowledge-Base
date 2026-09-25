// kb-export.js — everything the Manage → Export tab needs, as pure functions.
//
// WHY A SEPARATE MODULE
//   kb.js already carries the whole-corpus export (JSON/Markdown/CSV). What is
//   new here is per-class export: pick one or more courses, narrow by year and
//   by what the note actually is, and get either one file or a .zip that keeps
//   each assignment and each material as its own document — plus, optionally,
//   the real Drive attachments alongside them.
//
//   All of it is pure and node-testable. The only browser-facing halves are in
//   kb.js: the DOM wiring and the Drive fetches, which take the plan objects
//   this module produces.

// ---------------------------------------------------------------------------
// What a note IS.
//
// bundleFromRaw now tags courseWork as "assignment" and courseWorkMaterials as
// "material". Corpora built before that tag everything "note", and a student
// should not have to rebuild to filter — so fall back to reading the body,
// which archive-builder.js writes in a fixed shape: only an assignment can
// carry a due date, a grade, points, or the "Open assignment in Classroom"
// link.
// ---------------------------------------------------------------------------
const ASSIGNMENT_MARKERS = [
  "\nDue: ",
  "Max points:",
  "Your submission:",
  "[Open assignment in Classroom]",
];

export function noteItemKind(note = {}) {
  const declared = String(note.kind || "").toLowerCase();
  if (declared === "assignment" || declared === "material") return declared;
  if (declared === "announcement" || declared === "announcements") return "announcement";
  const body = `\n${String(note.x || "")}`;
  if (ASSIGNMENT_MARKERS.some((marker) => body.includes(marker))) return "assignment";
  return "material";
}

export const EXPORT_KINDS = Object.freeze(["assignment", "material", "announcement"]);

export const EXPORT_KIND_LABELS = Object.freeze({
  assignment: "Assignments",
  material: "Materials",
  announcement: "Announcements",
});

// ---------------------------------------------------------------------------
// Attachments.
//
// The KB note keeps attachments as markdown link lines, because that is what
// the browse view renders. Parsing them back out means attachment export works
// on a corpus that already exists — no rebuild, no schema migration.
// ---------------------------------------------------------------------------
const MD_LINK = /^\s*-\s*\[([^\]]*)\]\(([^)]*)\)\s*$/;

/** Pull `<id>` out of the handful of Drive/Docs URL shapes Classroom emits. */
export function driveFileId(url = "") {
  const s = String(url);
  const path = s.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (path) return path[1];
  const query = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (query) return query[1];
  return null;
}

function attachmentSource(url = "") {
  const s = String(url);
  if (/docs\.google\.com\/forms/.test(s)) return "form";
  if (/youtube\.com|youtu\.be/.test(s)) return "youtube";
  if (/drive\.google\.com|docs\.google\.com/.test(s)) return "drive";
  return "link";
}

/**
 * Every attachment referenced by a note, in body order and de-duplicated by URL.
 * The "Open assignment in Classroom" / "Open in Classroom" back-links are not
 * attachments and are skipped — they are a link to the note's own source page.
 */
export function noteAttachments(note = {}) {
  const out = [];
  const seen = new Set();
  for (const line of String(note.x || "").split("\n")) {
    const match = line.match(MD_LINK);
    if (!match) continue;
    const title = match[1].trim();
    const url = match[2].trim();
    if (!url || seen.has(url)) continue;
    if (/^Open (assignment )?in Classroom$/i.test(title)) continue;
    seen.add(url);
    const source = attachmentSource(url);
    out.push({
      title: title || "Attachment",
      url,
      source,
      driveId: source === "drive" ? driveFileId(url) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drive download planning.
//
// A Workspace document (Docs/Sheets/Slides) has no bytes of its own — it must
// be exported to a real format. Everything else streams with alt=media. A
// folder, a form, or a shortcut has nothing to fetch, so it stays a link.
// ---------------------------------------------------------------------------
const WORKSPACE_EXPORTS = Object.freeze({
  "application/vnd.google-apps.document": { mime: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  },
});

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

export function driveMetadataUrl(fileId) {
  return `${DRIVE_API}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size&supportsAllDrives=true`;
}

/**
 * Turn Drive metadata into "fetch this URL, save it under that name" — or null
 * when the file has no downloadable bytes.
 */
export function driveDownloadPlan(meta = {}) {
  const id = String(meta.id || "");
  if (!id) return null;
  const mime = String(meta.mimeType || "");
  const name = String(meta.name || "attachment").trim() || "attachment";
  if (mime === "application/vnd.google-apps.folder" || mime === "application/vnd.google-apps.form") {
    return null;
  }
  const workspace = WORKSPACE_EXPORTS[mime];
  if (workspace) {
    return {
      url: `${DRIVE_API}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(workspace.mime)}`,
      filename: `${name}.${workspace.ext}`,
      mime: workspace.mime,
    };
  }
  if (mime.startsWith("application/vnd.google-apps.")) return null; // shortcut, site, map…
  return {
    url: `${DRIVE_API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    filename: name,
    mime: mime || "application/octet-stream",
  };
}

// Why a download failed, as the reason shown to the student. Most failures are
// worth retrying next time (a file not shared yet, a network blip), but one is
// permanent: Google refuses to export a Workspace file over its export size
// limit (403 exportSizeLimitExceeded — a Doc full of images gets there fast).
// Retrying that forever kept its note flagged "new" on every visit.
export const TOO_LARGE_REASON = "too large for Google to export";

export function driveFailureReason(status, bodyText = "") {
  if (status === 403 && /exportSizeLimitExceeded/.test(String(bodyText))) return TOO_LARGE_REASON;
  return `Drive ${status}`;
}

/**
 * The picker's title. Google's current picker shows its own "Grant access to
 * files" header and ignores this (seen on the live site 2026-09-25), so the
 * instruction that students actually see is pickerHint below; this stays as a
 * harmless fallback for picker versions that do render setTitle.
 */
export function pickerTitle(round = 1, rounds = 1, fileCount = 0) {
  const how = "click the first file, Shift+click the last, then Select";
  const what = fileCount > 1 ? `all ${fileCount} files` : "the file";
  return rounds > 1
    ? `Round ${round} of ${rounds}: select ${what} — ${how}`
    : `Select ${what} — ${how}`;
}

/**
 * The status line under the picker — our own text, so it is always visible.
 * The Picker has no "Select all" button (the old hint told students to press
 * one); clicking the first file and Shift+clicking the last selects the range.
 */
export function pickerHint(fileCount = 0) {
  if (fileCount <= 1) return "Google needs you to confirm 1 new file — click it, then Select.";
  return `Google needs you to confirm ${fileCount} new files — click the first, Shift+click the last, then Select.`;
}

/** "1 item", "3 items" — the export messages said "Exported 1 items". */
export function countLabel(count, noun) {
  const n = Number(count) || 0;
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** Failures that will never succeed, so the id belongs in the unavailable set. */
export function isPermanentDriveFailure(reason) {
  return reason === "nothing to download" || reason === TOO_LARGE_REASON;
}

// ---------------------------------------------------------------------------
// Handing Drive file ids to the Google Picker.
//
// `DocsView.setFileIds` takes a COMMA-JOINED STRING of ids and opens the picker
// pre-navigated to exactly those files, so a student grants a whole class in one
// pass instead of hunting for files in their Drive. The catch is that the string
// ends up in a URL: measured against the real corpus, 200 ids (7,349 chars)
// opens fine and 400 (~14,800 chars) fails outright with "docs.google.com
// refused to connect". So batches are capped on BOTH counts — the id count for
// predictability, and the character budget because ids are not fixed width.
//
// An id the student can no longer reach is dropped from the picker silently
// rather than erroring (Google documents this), which is why the caller compares
// what came back against what it offered instead of assuming a full grant.
// ---------------------------------------------------------------------------
export const PICKER_MAX_IDS = 200;
export const PICKER_MAX_CHARS = 7500;

export function driveIdBatches(ids, { maxIds = PICKER_MAX_IDS, maxChars = PICKER_MAX_CHARS } = {}) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean))];
  const batches = [];
  let current = [];
  let chars = 0;
  for (const id of clean) {
    const cost = id.length + (current.length ? 1 : 0); // the joining comma
    if (current.length && (current.length >= maxIds || chars + cost > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(id);
    chars += current.length === 1 ? id.length : cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Every distinct Drive id the given notes reference, in note order. */
export function driveIdsForNotes(notes) {
  const seen = new Set();
  for (const note of Array.isArray(notes) ? notes : []) {
    for (const attachment of noteAttachments(note)) {
      if (attachment.driveId) seen.add(attachment.driveId);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Selection: which notes an export covers.
// ---------------------------------------------------------------------------
export function exportSelectionModel(raw = {}) {
  const list = (value) => (Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : []);
  const kinds = list(raw.kinds).filter((k) => EXPORT_KINDS.includes(k));
  return {
    courses: [...new Set(list(raw.courses))],
    years: [...new Set(list(raw.years))],
    // No kind ticked means "everything" rather than "nothing" — an empty export
    // is never what an empty filter row is asking for.
    kinds: kinds.length ? [...new Set(kinds)] : [...EXPORT_KINDS],
    format: ["zip", "md", "json", "csv"].includes(raw.format) ? raw.format : "zip",
    attachments: raw.attachments === true,
  };
}

export function selectExportNotes(bundle, raw = {}) {
  const selection = exportSelectionModel(raw);
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const courses = new Set(selection.courses);
  const years = new Set(selection.years);
  const kinds = new Set(selection.kinds);
  return notes.filter((note) => {
    if (courses.size && !courses.has(String(note.course || ""))) return false;
    if (years.size && !years.has(String(note.y || ""))) return false;
    return kinds.has(noteItemKind(note));
  });
}

/** The class list the picker renders: every course, with what it would yield. */
export function exportCourseOptions(bundle) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const byCourse = new Map();
  const ensure = (name) => {
    if (!byCourse.has(name)) {
      byCourse.set(name, {
        name,
        years: [],
        noteCount: 0,
        counts: { assignment: 0, material: 0, announcement: 0 },
      });
    }
    return byCourse.get(name);
  };
  for (const course of Array.isArray(bundle?.courses) ? bundle.courses : []) {
    const name = String(course?.name || "").trim();
    if (name) ensure(name);
  }
  for (const note of notes) {
    const entry = ensure(String(note.course || "Uncategorized"));
    entry.noteCount++;
    entry.counts[noteItemKind(note)]++;
    const year = String(note.y || "");
    if (year && !entry.years.includes(year)) entry.years.push(year);
  }
  return [...byCourse.values()]
    .map((entry) => ({ ...entry, years: entry.years.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function exportYearOptions(bundle) {
  const years = new Set();
  for (const note of Array.isArray(bundle?.notes) ? bundle.notes : []) {
    const year = String(note.y || "");
    if (year) years.add(year);
  }
  return [...years].sort();
}

// ---------------------------------------------------------------------------
// The file tree a .zip export contains.
// ---------------------------------------------------------------------------
export function safeSegment(value, fallback = "untitled") {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\?%*:"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : fallback;
}

function uniquePath(path, used) {
  if (!used.has(path)) { used.add(path); return path; }
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  let n = 2;
  while (used.has(`${stem} (${n})${ext}`)) n++;
  const next = `${stem} (${n})${ext}`;
  used.add(next);
  return next;
}

export function noteMarkdown(note = {}) {
  const lines = [`# ${note.t || "Untitled"}`, ""];
  const meta = [
    note.course ? `**Class:** ${note.course}` : "",
    note.y ? `**Year:** ${note.y}` : "",
    note.topic ? `**Topic:** ${note.topic}` : "",
    `**Type:** ${EXPORT_KIND_LABELS[noteItemKind(note)].replace(/s$/, "")}`,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join("  \n"), "");
  if (note.s) lines.push(`> ${note.s}`, "");
  const body = String(note.x || "").trim();
  if (body) lines.push(body, "");
  if (note.p) lines.push("---", "", `_Source: ${note.p}_`, "");
  return lines.join("\n");
}

/**
 * One file per note, foldered `Class/Type/Topic/Title.md`, plus a README index.
 * `attachmentsByNotePath` (note path → [{title, path}]) is folded into the
 * index so the README says where each downloaded file landed.
 */
export function exportFileTree(notes, { attachmentsByNotePath = new Map(), generatedAt = null, newSinceDate = null } = {}) {
  const used = new Set();
  const files = [];
  const index = ["# Classroom export", ""];
  if (newSinceDate) {
    index.push(`_This is an update — only items new since ${new Date(newSinceDate).toLocaleString()}._`, "");
  }
  if (generatedAt) index.push(`_Exported ${new Date(generatedAt).toLocaleString()}_`, "");
  index.push(`_${notes.length} ${notes.length === 1 ? "item" : "items"}_`, "");

  const byCourse = new Map();
  for (const note of notes) {
    const course = String(note.course || "Uncategorized");
    if (!byCourse.has(course)) byCourse.set(course, []);
    byCourse.get(course).push(note);
  }

  for (const [course, courseNotes] of [...byCourse.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    index.push(`## ${course}`, "");
    for (const kind of EXPORT_KINDS) {
      const group = courseNotes.filter((note) => noteItemKind(note) === kind);
      if (!group.length) continue;
      index.push(`### ${EXPORT_KIND_LABELS[kind]}`, "");
      for (const note of group) {
        const segments = [
          safeSegment(course, "Class"),
          EXPORT_KIND_LABELS[kind],
          note.topic ? safeSegment(note.topic, "General") : null,
          `${safeSegment(note.t, "note")}.md`,
        ].filter(Boolean);
        const path = uniquePath(segments.join("/"), used);
        files.push({ path, text: noteMarkdown(note) });
        index.push(`- [${note.t || "Untitled"}](${encodeURI(path)})`);
        for (const attachment of attachmentsByNotePath.get(note.p) || []) {
          index.push(`  - 📎 [${attachment.title || attachment.path}](${encodeURI(attachment.path)})`);
        }
      }
      index.push("");
    }
  }
  return { files, index: index.join("\n") };
}

/** Where a downloaded attachment goes: beside its note, in an Attachments box. */
export function attachmentPath(note, filename, used = new Set()) {
  const segments = [
    safeSegment(note.course || "Uncategorized", "Class"),
    EXPORT_KIND_LABELS[noteItemKind(note)],
    "Attachments",
    safeSegment(note.t, "note"),
    safeSegment(filename, "attachment"),
  ];
  return uniquePath(segments.join("/"), used);
}

export function exportDownloadName(selection, date = new Date().toISOString().slice(0, 10), { newOnly = false } = {}) {
  const model = exportSelectionModel(selection);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : "export";
  const stem = model.courses.length === 1
    ? safeSegment(model.courses[0], "class")
    : model.courses.length
      ? `${model.courses.length} classes`
      : "classroom-kb";
  const ext = model.format === "zip" ? "zip" : model.format;
  return `${stem}${newOnly ? "-new" : ""} ${safeDate}.${ext}`.replace(/\s+/g, "-");
}

// ---------------------------------------------------------------------------
// Export history — "what have I already downloaded", THIS BROWSER ONLY.
//
// Kept as a plain, pure data shape so the panel's "only what's new" logic is
// unit-testable without a DOM or localStorage: kb.js owns the storage key and
// the try/catch, this module owns what the data means.
// ---------------------------------------------------------------------------
export function emptyExportHistory() {
  return { v: 1, notes: {}, files: {} };
}

/** Tolerates garbage (corrupt JSON, wrong shape, `null`) by falling back empty. */
export function parseExportHistory(raw) {
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || typeof data !== "object") return emptyExportHistory();
    const notes = data.notes && typeof data.notes === "object" ? { ...data.notes } : {};
    const files = data.files && typeof data.files === "object" ? { ...data.files } : {};
    return { v: 1, notes, files };
  } catch {
    return emptyExportHistory();
  }
}

/** A new history with every given note (and downloaded Drive id) stamped `date`. */
export function recordExport(history, notes, downloadedDriveIds, date = new Date().toISOString()) {
  const base = parseExportHistory(history);
  const nextNotes = { ...base.notes };
  for (const note of Array.isArray(notes) ? notes : []) {
    if (note?.p) nextNotes[note.p] = date;
  }
  const nextFiles = { ...base.files };
  for (const id of Array.isArray(downloadedDriveIds) ? downloadedDriveIds : []) {
    if (id) nextFiles[id] = date;
  }
  return { v: 1, notes: nextNotes, files: nextFiles };
}

/**
 * Of the given notes, which are new since the last export: never exported
 * before, OR (when attachments are on) carrying a Drive attachment that was
 * never downloaded. `driveIds` lists only the not-yet-exported ids, so a
 * caller can grant/download exactly those rather than the whole selection.
 */
export function newSinceExport(notes, history, { attachments = false, ignoreIds = null } = {}) {
  const base = parseExportHistory(history);
  // Ids we already know can never be downloaded (deleted at the source, never
  // shared, nothing exportable). They must not count as "new", or a class
  // holding one never reaches "up to date".
  const ignored = new Set(ignoreIds || []);
  const outNotes = [];
  const driveIds = new Set();
  for (const note of Array.isArray(notes) ? notes : []) {
    const seenNote = note?.p ? Object.prototype.hasOwnProperty.call(base.notes, note.p) : false;
    let hasNewFile = false;
    if (attachments) {
      for (const id of driveIdsForNotes([note])) {
        if (!ignored.has(id) && !Object.prototype.hasOwnProperty.call(base.files, id)) {
          hasNewFile = true;
          driveIds.add(id);
        }
      }
    }
    if (!seenNote || hasNewFile) outNotes.push(note);
  }
  return { notes: outNotes, driveIds: [...driveIds] };
}

/** What a class row shows: when it was last exported, and how much is new. */
export function classExportStatus(notesOfClass, history, opts = {}) {
  const base = parseExportHistory(history);
  const list = Array.isArray(notesOfClass) ? notesOfClass : [];
  if (!list.length) return { lastExportedAt: null, newCount: 0, exportedBefore: false };
  let lastExportedAt = null;
  let exportedBefore = false;
  for (const note of list) {
    const at = note?.p ? base.notes[note.p] : undefined;
    if (at) {
      exportedBefore = true;
      if (!lastExportedAt || at > lastExportedAt) lastExportedAt = at;
    }
  }
  const { notes: newNotes } = newSinceExport(list, base, opts);
  return { lastExportedAt, newCount: newNotes.length, exportedBefore };
}

/**
 * Of the ids a selection needs, which still need a picker pass: not already
 * granted, and not already offered-and-dropped (deleted at the source).
 */
export function idsStillToGrant(ids, granted = [], unavailable = []) {
  const grantedSet = new Set(Array.isArray(granted) ? granted : []);
  const unavailableSet = new Set(Array.isArray(unavailable) ? unavailable : []);
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean))];
  return clean.filter((id) => !grantedSet.has(id) && !unavailableSet.has(id));
}

// ---------------------------------------------------------------------------
// A minimal store-only ZIP writer.
//
// Deliberately not a dependency. The archive holds markdown and already-
// compressed PDFs/images, the browser has no zip primitive, and "stored"
// entries need nothing but CRC-32 and two fixed-layout headers — far less
// surface than pulling a compression library into a no-bundler static site.
//
// WHY IT EMITS PARTS RATHER THAN ONE ARRAY
//   The first draft allocated the finished archive as a single Uint8Array and
//   then copied it again into a Blob, on top of holding every downloaded
//   attachment on the JS heap. Peak memory was roughly three times the payload:
//   one real class of attachments reached 1.6 GB and the tab was killed
//   ("Oops, something went wrong") after every file had downloaded fine.
//
//   So the writer produces a LIST of parts — small header arrays interleaved
//   with each entry's body, which may be a Blob. A Blob lives in the browser's
//   blob store, not the JS heap, and spills to disk, so `new Blob(parts)`
//   assembles an arbitrarily large archive without ever materialising it in
//   memory. That is why an entry may carry `crc`/`size` precomputed: the body's
//   bytes are checksummed once as they stream in, and never read again.
// ---------------------------------------------------------------------------
let crcTable = null;
function crc32Table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

// Incremental CRC-32, so a download can be checksummed chunk by chunk while it
// streams instead of being buffered whole just to hash it.
export const CRC32_INIT = 0xffffffff;

export function crc32Update(crc, bytes) {
  const table = crc32Table();
  let c = crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

export function crc32Final(crc) {
  return ((crc >>> 0) ^ 0xffffffff) >>> 0;
}

export function crc32(bytes) {
  return crc32Final(crc32Update(CRC32_INIT, bytes));
}

const utf8 = new TextEncoder();

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// The classic zip format keeps sizes and offsets in 32 bits. ZIP64 lifts that,
// and is not worth writing for a school export — but a silently truncated
// offset produces an archive that unzips to garbage, so refuse instead.
const ZIP32_MAX = 0xffffffff;
const ZIP32_MAX_ENTRIES = 0xffff;

function prepareEntry(entry) {
  const name = utf8.encode(String(entry?.path ?? ""));
  if (entry?.blob) {
    const size = Number(entry.size ?? entry.blob.size ?? 0);
    if (!Number.isFinite(size) || size < 0) throw new Error(`"${entry.path}" has no readable size`);
    if (!Number.isFinite(entry.crc)) throw new Error(`"${entry.path}" was handed over without a checksum`);
    return { name, body: entry.blob, size, crc: entry.crc >>> 0 };
  }
  const data = entry?.data instanceof Uint8Array ? entry.data : utf8.encode(String(entry?.text ?? ""));
  return {
    name,
    body: data,
    size: data.length,
    crc: Number.isFinite(entry?.crc) ? entry.crc >>> 0 : crc32(data),
  };
}

/**
 * The archive as a list of parts: `Uint8Array` headers interleaved with each
 * entry's body (a `Uint8Array` or a `Blob`). Hand it to `new Blob(parts)`.
 *
 * @param {Array<{path:string, data?:Uint8Array, text?:string, blob?:Blob, crc?:number, size?:number}>} entries
 * @returns {Array<Uint8Array|Blob>}
 */
export function buildZipParts(entries, { date = new Date() } = {}) {
  const stamp = dosDateTime(date);
  const prepared = (Array.isArray(entries) ? entries : []).map(prepareEntry);
  if (prepared.length > ZIP32_MAX_ENTRIES) {
    throw new Error(`That is ${prepared.length.toLocaleString()} files — a zip holds 65,535. Export fewer classes at a time.`);
  }

  const parts = [];
  const offsets = [];
  let offset = 0;
  for (const entry of prepared) {
    if (entry.size > ZIP32_MAX) {
      throw new Error(`"${utf8.decode(entry.name)}" is over 4 GB, which this zip format cannot hold.`);
    }
    offsets.push(offset);
    const header = new Uint8Array(30 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);       // version needed
    view.setUint16(6, 0x0800, true);   // UTF-8 filenames
    view.setUint16(8, 0, true);        // stored
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.size, true);
    view.setUint32(22, entry.size, true);
    view.setUint16(26, entry.name.length, true);
    view.setUint16(28, 0, true);
    header.set(entry.name, 30);
    parts.push(header, entry.body);
    offset += header.length + entry.size;
    if (offset > ZIP32_MAX) {
      throw new Error("This export is over 4 GB. Export one class at a time, or untick attachments.");
    }
  }

  const centralStart = offset;
  const directory = new Uint8Array(prepared.reduce((n, e) => n + 46 + e.name.length, 0) + 22);
  const view = new DataView(directory.buffer);
  let pos = 0;
  const u16 = (v) => { view.setUint16(pos, v, true); pos += 2; };
  const u32 = (v) => { view.setUint32(pos, v >>> 0, true); pos += 4; };
  prepared.forEach((entry, i) => {
    u32(0x02014b50);
    u16(20); u16(20);
    u16(0x0800);
    u16(0);
    u16(stamp.time); u16(stamp.date);
    u32(entry.crc);
    u32(entry.size);
    u32(entry.size);
    u16(entry.name.length);
    u16(0); u16(0); u16(0); u16(0);
    u32(0);             // external attributes
    u32(offsets[i]);
    directory.set(entry.name, pos); pos += entry.name.length;
  });

  // Capture the directory's end BEFORE the end-of-central-directory record
  // starts consuming `pos` — otherwise its own 12 bytes are counted as part
  // of the directory it is describing, and unzip reports a truncated archive.
  const centralEnd = pos;
  u32(0x06054b50);
  u16(0); u16(0);
  u16(prepared.length); u16(prepared.length);
  u32(centralEnd);
  u32(centralStart);
  u16(0);
  parts.push(directory);
  return parts;
}

/**
 * The whole archive as one Blob. This is what the browser downloads: the bytes
 * of every attachment stay in the blob store, so a 1 GB export costs the JS
 * heap nothing beyond the headers.
 */
export function buildZipBlob(entries, options = {}) {
  return new Blob(buildZipParts(entries, options), { type: "application/zip" });
}

/**
 * The same archive as a single Uint8Array — for Node, tests, and any caller
 * with nothing but in-memory entries. Blob-bodied entries have no synchronous
 * bytes, so they are rejected rather than silently dropped.
 *
 * @param {Array<{path:string, data?:Uint8Array, text?:string}>} entries
 * @returns {Uint8Array} a complete, stored (uncompressed) zip archive
 */
export function buildZip(entries, options = {}) {
  const parts = buildZipParts(entries, options);
  let total = 0;
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) throw new Error("buildZip cannot flatten a Blob entry — use buildZipBlob");
    total += part.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// ---------------------------------------------------------------------------
// "Generate / update database" needs to say what it actually did.
//
// The old done-line said "Saved N notes" whether or not anything changed, which
// reads as "there is still more to fetch" when the honest answer is "you are
// already up to date".
// ---------------------------------------------------------------------------
export function buildResultMessage({ before = 0, after = 0, removed = 0 } = {}) {
  const added = Math.max(0, after - before + removed);
  if (!after) return "Nothing found in Classroom yet.";
  if (!added && !removed) return `✅ Already up to date — nothing new. ${after.toLocaleString()} notes.`;
  const parts = [];
  if (added) parts.push(`${added.toLocaleString()} new ${added === 1 ? "note" : "notes"}`);
  if (removed) parts.push(`${removed.toLocaleString()} removed`);
  return `✅ Updated — ${parts.join(", ")}. ${after.toLocaleString()} notes in total.`;
}
