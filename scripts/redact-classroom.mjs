// redact-classroom.mjs — turn one raw Classroom capture into committable fixtures.
//
// WHY THIS IS NOT OPTIONAL
//   This repo is PUBLIC (Pepuldope/Classroom-Knowledge-Base). A raw capture
//   carries real course names, real assignment text, teacher names and real
//   Drive file ids. None of that may land in tests/fixtures/.
//
// WHAT IS KEPT (this is the whole point — shape fidelity)
//   field names, nesting, array lengths, key presence, every enum value
//   (courseState / state / workType / assigneeMode), timestamps, dueDate and
//   dueTime object shapes, numbers, booleans, id LENGTH and charset class, URL
//   scheme and host, and which attachment variant each attachment is
//   (driveFile / link / youTubeVideo / form).
//
// WHAT IS REPLACED
//   every human-readable string, every id, and every URL path.
//
// HOW THE GUARD CAN TELL
//   tests/fixtures-privacy.test.js has to be able to PROVE a fixture is
//   synthetic, not merely look at it and hope. So the replacements are not
//   random:
//     - ids are sequence-derived — zero-padded or letter-padded counters that
//       keep the original length and charset class. A real Classroom id is
//       never a zero-padded counter, so "provably generated" and "same shape"
//       both hold.
//     - text is drawn ONLY from VOCAB below, which the guard imports. A word
//       outside that list in a fixture means real content leaked.
//
// USAGE
//   node scripts/redact-classroom.mjs [raw.json] [--out tests/fixtures/classroom]
//
//   Default input is the scratchpad path capture-classroom.js tells you to save
//   to. The input is never written to and never copied.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The entire permitted vocabulary of redacted text. The guard imports this, so
// adding a word here widens what a fixture is allowed to contain — do that
// deliberately, never to make a failing guard pass.
export const VOCAB = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
  "unit", "module", "chapter", "section", "topic", "task", "sheet", "notes",
  "review", "practice", "summary", "draft", "handout", "reading", "problem",
  "set", "lab", "essay", "report", "quiz", "test", "exam", "project",
];

// Used only when the original string contained non-ASCII, so that fixtures keep
// exercising diacritic handling, collation and the sprint-topic detection that a
// pure-ASCII placeholder would quietly stop covering. Still synthetic.
export const VOCAB_DIACRITIC = [
  "Šprint", "téma", "úloha", "písomka", "cvičenie", "poznámky", "zhrnutie",
  "článok", "prezentácia", "východisko", "úvod", "záver", "výsledky",
];

// Strings under these keys pass through untouched: they are enums, timestamps
// or other structural facts, not content. Anything NOT listed here is redacted,
// so a field Google adds later is redacted by default rather than leaked.
// NOTE: `calendarId` was in this list on the first draft and leaked
// "sk.school_<name>@group.calendar.google.com" straight into the fixture — the
// school's name, verbatim. It ends in "Id", so removing it from here is enough:
// it now goes through the id map. That is exactly the failure this set invites,
// so add to it only for a value you have confirmed is an enum or a timestamp.
const PASS_THROUGH_STRINGS = new Set([
  "courseState", "state", "workType", "assigneeMode", "submissionModifiedMode",
  "courseWorkType", "shareMode", "gradeState", "previewVersion",
  "creationTime", "updateTime", "scheduledTime", "dueDateTime",
  "nextPageToken",
]);

// `section` is the one content field with real structural value: courseSchoolYear
// / schoolYearFromSection() derive the school year from it, and redacting it to
// vocabulary words would quietly stop covering that. A bare class designation
// ("3.A", "II B", "9") identifies nothing on its own, so it is kept — but only
// when it matches that shape exactly. Anything longer is a free-text section name
// and gets redacted like everything else.
const BARE_CLASS_DESIGNATION = /^\s*\d{1,2}\s*[.\-/]?\s*[A-Za-z]?\s*$/;

// Keys whose string values are URLs: scheme and host are structural (a
// driveFile link vs a forms.gle link vs youtube.com changes how the app renders
// the attachment), the path is content.
const URL_KEYS = new Set([
  "alternateLink", "thumbnailUrl", "url", "formUrl", "responseUrl",
  "teacherFolderAlternateLink", "embedCode",
]);

const isIdKey = (key) => key === "id" || /Id$/.test(key);

/** Deterministic, reversible-by-nobody id map that preserves shape. */
function makeIdMap() {
  const seen = new Map();
  let n = 0;
  return (real) => {
    if (typeof real !== "string" || real === "") return real;
    if (seen.has(real)) return seen.get(real);
    n += 1;
    const counter = String(n);
    let synthetic;
    if (/^\d+$/.test(real)) {
      // Numeric Classroom id — keep the digit count, zero-pad the counter.
      //
      // At least ONE leading zero, always. A real Classroom id never starts with
      // 0, so that single guaranteed character is what lets
      // tests/fixtures-privacy.test.js prove an id is generated rather than just
      // observe that it is numeric. Without it the guard could not tell
      // "745123908812" from a synthetic id of the same length, and a real id
      // pasted into a fixture passed the check.
      synthetic = counter.padStart(Math.max(real.length, counter.length + 1), "0");
    } else {
      // Mixed-charset id (Drive file ids, topic ids). Keep the length, pad with
      // 'A' so it is unmistakably generated.
      const pad = Math.max(real.length - counter.length, 0);
      synthetic = "A".repeat(pad) + counter;
    }
    seen.set(real, synthetic);
    return synthetic;
  };
}

/** Synthetic text with the same word count and the same ASCII-ness. */
function makeTextMap() {
  const seen = new Map();
  let n = 0;
  return (real) => {
    if (typeof real !== "string" || real.trim() === "") return real;
    if (seen.has(real)) return seen.get(real);
    n += 1;
    const hasNonAscii = /[^\x00-\x7F]/.test(real);
    const vocab = hasNonAscii ? VOCAB_DIACRITIC : VOCAB;
    // Preserve word count, which is what makes snippet/truncation assertions
    // meaningful, without preserving any word.
    const words = Math.min(Math.max(real.trim().split(/\s+/).length, 1), 40);
    const out = [];
    for (let i = 0; i < words; i++) out.push(vocab[(n + i) % vocab.length]);
    const synthetic = out.join(" ");
    seen.set(real, synthetic);
    return synthetic;
  };
}

/** Keep scheme + host, replace the path with a synthetic of similar length. */
function makeUrlMap(mapText) {
  const seen = new Map();
  let n = 0;
  return (real) => {
    if (typeof real !== "string" || !/^https?:\/\//.test(real)) {
      // Not a URL after all (embedCode can be raw HTML) — treat as text.
      return mapText(real);
    }
    if (seen.has(real)) return seen.get(real);
    n += 1;
    let synthetic;
    try {
      const u = new URL(real);
      const depth = u.pathname.split("/").filter(Boolean).length || 1;
      const segs = Array.from({ length: depth }, (_, i) => `s${n}${i}`);
      synthetic = `${u.protocol}//${u.host}/${segs.join("/")}`;
    } catch {
      synthetic = `https://example.invalid/s${n}`;
    }
    seen.set(real, synthetic);
    return synthetic;
  };
}

function redact(value, key, maps) {
  if (Array.isArray(value)) return value.map((v) => redact(v, key, maps));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, maps);
    return out;
  }
  if (typeof value !== "string") return value;           // numbers, booleans, null
  if (PASS_THROUGH_STRINGS.has(key)) return value;        // enums + timestamps
  if (key === "section" && BARE_CLASS_DESIGNATION.test(value)) return value.trim();
  if (isIdKey(key)) return maps.id(value);
  if (URL_KEYS.has(key)) return maps.url(value);
  if (/@/.test(value)) return "student@example.edu";      // emailAddress et al
  return maps.text(value);
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx === -1 ? "tests/fixtures/classroom" : args[outIdx + 1];
  const input = args.find((a) => !a.startsWith("--") && a !== outDir)
    || "scratchpad/_classroom-raw.json";

  const raw = JSON.parse(readFileSync(input, "utf8"));
  const maps = {};
  maps.id = makeIdMap();
  maps.text = makeTextMap();
  maps.url = makeUrlMap(maps.text);

  const courses = redact(raw.courses || [], "courses", maps);

  // courseData is keyed by real course id — rekey it through the same id map so
  // the fixture stays internally consistent with the redacted courses.
  const courseData = {};
  for (const [realId, facets] of Object.entries(raw.courseData || {})) {
    // Drop the __pages/__denied bookkeeping from the fixture itself; it is
    // summarised into the manifest instead, where it is a fact about the capture
    // rather than something the app would ever receive.
    const clean = Object.fromEntries(
      Object.entries(facets).filter(([k]) => !k.includes("__")),
    );
    courseData[maps.id(realId)] = redact(clean, "courseData", maps);
  }

  // Facts about the capture, carrying no content. This is what tells a reader
  // whether the fixture is worth anything: did anything actually paginate, did
  // anything actually get denied.
  const manifest = {
    note: "Redacted from one real Classroom capture by scripts/redact-classroom.mjs. No real content.",
    capturedAt: raw.capturedAt || null,
    pageSize: raw.pageSize || null,
    courseCount: courses.length,
    facetCounts: Object.fromEntries(
      Object.entries(courseData).map(([id, f]) => [id, Object.fromEntries(
        Object.entries(f).map(([k, v]) => [k, Array.isArray(v) ? v.length : null]),
      )]),
    ),
    paginatedFacets: Object.entries(raw.courseData || {}).flatMap(([, f]) =>
      Object.entries(f).filter(([k, v]) => k.endsWith("__pages") && Array.isArray(v) && v.length > 1)
        .map(([k, v]) => `${k.replace("__pages", "")}=${v.length}pages`)),
    deniedFacets: Object.entries(raw.courseData || {}).flatMap(([, f]) =>
      Object.keys(f).filter((k) => k.endsWith("__denied")).map((k) => k.replace("__denied", ""))),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "courses.json"), JSON.stringify(courses, null, 2) + "\n");
  writeFileSync(join(outDir, "course-data.json"), JSON.stringify(courseData, null, 2) + "\n");
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`redacted ${courses.length} course(s) -> ${outDir}`);
  console.log(`  paginated: ${manifest.paginatedFacets.join(", ") || "none"}`);
  console.log(`  denied:    ${manifest.deniedFacets.join(", ") || "none"}`);
  console.log("now run: node --test tests/fixtures-privacy.test.js");
}

// Importable for the guard (VOCAB), runnable as a script.
//
// The usual `import.meta.url === \`file://${process.argv[1]}\`` idiom is wrong
// here: this checkout lives under a path containing spaces and an "@", which
// import.meta.url percent-encodes and process.argv[1] does not. That comparison
// silently never matched, so running this file did nothing at all and exited 0.
// Compare real paths instead.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
