// fixtures-privacy.test.js — prove the committed Classroom fixtures are synthetic.
//
// WHY
//   This repo is public. tests/fixtures/classroom/ is derived from one real
//   capture of Peter's Google Classroom, and the only thing standing between
//   "shape fidelity" and "published his school's coursework" is
//   scripts/redact-classroom.mjs having actually run.
//
//   Eyeballing a fixture does not scale and does not survive a future capture by
//   someone in a hurry. So this does not look for bad content — it requires
//   every value to be provably generated:
//
//     - ids must be sequence-derived (digits, or 'A' padding then digits). A
//       real Classroom id is never zero-padded, and a real Drive id is never
//       'AAAA…A12'.
//     - free text must be built only from the redactor's own VOCAB. Any word
//       outside it is, by definition, content that came from somewhere else.
//     - URL paths must be the redactor's `s<n><i>` segments. Host and scheme are
//       deliberately preserved, so those are allowed through.
//     - the only email permitted anywhere is student@example.edu.
//
//   It SKIPS cleanly when the fixtures are absent, so the suite stays green
//   before the first capture and on a checkout that never runs one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { VOCAB, VOCAB_DIACRITIC } from "../scripts/redact-classroom.mjs";

// KB_FIXTURE_DIR exists so the redactor's own output can be checked from a
// scratch directory before anything is committed. Unset, it guards the real thing.
const DIR = process.env.KB_FIXTURE_DIR || "tests/fixtures/classroom";
const FILES = ["courses.json", "course-data.json", "manifest.json"];

// Must match scripts/redact-classroom.mjs. Kept as its own copy on purpose: if
// the redactor widens what it passes through, this test should fail until
// someone confirms the new field is genuinely structural and not content.
const PASS_THROUGH_STRINGS = new Set([
  "courseState", "state", "workType", "assigneeMode", "submissionModifiedMode",
  "courseWorkType", "shareMode", "gradeState", "previewVersion",
  "creationTime", "updateTime", "scheduledTime", "dueDateTime",
  "nextPageToken",
]);

// The redactor keeps `section` when it is a bare class designation, because
// schoolYearFromSection() reads it. Mirrored here so a free-text section name
// cannot sneak through under the same key.
const BARE_CLASS_DESIGNATION = /^\d{1,2}\s*[.\-/]?\s*[A-Za-z]?$/;
const URL_KEYS = new Set([
  "alternateLink", "thumbnailUrl", "url", "formUrl", "responseUrl",
  "teacherFolderAlternateLink", "embedCode",
]);
// Manifest keys are our own prose about the capture, not captured content.
const MANIFEST_OWN_KEYS = new Set(["note", "capturedAt", "paginatedFacets", "deniedFacets"]);

const ALLOWED_WORDS = new Set([...VOCAB, ...VOCAB_DIACRITIC]);
// A numeric id MUST carry a leading zero and a mixed-charset id MUST be
// 'A'-padded. Both are things the real API never produces, which is the only
// reason this check has any force. The first draft accepted any run of digits,
// and a real id pasted into a fixture sailed straight through it.
const SYNTHETIC_ID = /^(?:0\d*|A+\d+)$/;
const SYNTHETIC_PATH_SEG = /^s\d+$/;
const isIdKey = (key) => key === "id" || /Id$/.test(key);

const present = existsSync(DIR) && FILES.every((f) => existsSync(`${DIR}/${f}`));

/** Every (path, key, string) triple in the fixture, for assertion by the caller. */
function* strings(value, key = "", path = "$") {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* strings(v, key, `${path}[${i}]`);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* strings(v, k, `${path}.${k}`);
    return;
  }
  if (typeof value === "string") yield { value, key, path };
}

function loadAll() {
  return FILES.map((f) => ({ file: f, data: JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) }));
}

test("Classroom fixtures contain no real identifiers", { skip: !present && `${DIR} not captured yet` }, () => {
  for (const { file, data } of loadAll()) {
    for (const { value, key, path } of strings(data)) {
      if (file === "manifest.json" && MANIFEST_OWN_KEYS.has(key)) continue;
      if (!isIdKey(key)) continue;
      assert.match(
        value, SYNTHETIC_ID,
        `${file} ${path}: id "${value}" is not sequence-derived — was the redactor run?`,
      );
    }
  }
});

test("Classroom fixtures contain no real free text", { skip: !present && `${DIR} not captured yet` }, () => {
  for (const { file, data } of loadAll()) {
    for (const { value, key, path } of strings(data)) {
      if (file === "manifest.json" && MANIFEST_OWN_KEYS.has(key)) continue;
      if (isIdKey(key) || URL_KEYS.has(key) || PASS_THROUGH_STRINGS.has(key)) continue;
      if (value.trim() === "") continue;
      if (value === "student@example.edu") continue;
      if (key === "section") {
        assert.match(value, BARE_CLASS_DESIGNATION,
          `${file} ${path}: section "${value}" is free text, not a bare class designation`);
        continue;
      }
      for (const word of value.trim().split(/\s+/)) {
        assert.ok(
          ALLOWED_WORDS.has(word),
          `${file} ${path}: "${word}" is not in the redactor's VOCAB — real content leaked`,
        );
      }
    }
  }
});

test("Classroom fixture URLs keep their host but not their path", { skip: !present && `${DIR} not captured yet` }, () => {
  for (const { file, data } of loadAll()) {
    for (const { value, key, path } of strings(data)) {
      if (!URL_KEYS.has(key) || value.trim() === "") continue;
      const u = new URL(value);
      for (const seg of u.pathname.split("/").filter(Boolean)) {
        assert.match(
          seg, SYNTHETIC_PATH_SEG,
          `${file} ${path}: URL path segment "${seg}" is not synthetic`,
        );
      }
    }
  }
});

test("no email other than student@example.edu appears in the fixtures", { skip: !present && `${DIR} not captured yet` }, () => {
  for (const { file, data } of loadAll()) {
    for (const { value, path } of strings(data)) {
      const found = value.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
      for (const email of found) {
        assert.equal(email, "student@example.edu", `${file} ${path}: real-looking email "${email}"`);
      }
    }
  }
});

// A fixture that turned out to contain no pagination and no denials still has
// value for list keys, but the two paths we most wanted covered would be
// uncovered — and silently. Say so out loud instead.
test("the capture manifest records whether pagination and denials were seen", { skip: !present && `${DIR} not captured yet` }, () => {
  const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8"));
  assert.ok(Array.isArray(manifest.paginatedFacets), "manifest.paginatedFacets missing");
  assert.ok(Array.isArray(manifest.deniedFacets), "manifest.deniedFacets missing");
  assert.ok(manifest.courseCount > 0, "manifest records no courses — capture was empty");
  if (manifest.paginatedFacets.length === 0) {
    console.log("  note: nothing in this capture paginated — the nextPageToken path is still fixture-uncovered");
  }
  if (manifest.deniedFacets.length === 0) {
    console.log("  note: nothing in this capture was denied — the 403/404 path is still fixture-uncovered");
  }
});
