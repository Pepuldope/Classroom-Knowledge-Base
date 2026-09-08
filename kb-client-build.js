// kb-client-build.js — pure transformations for the private browser-local KB.
// Classroom data is fetched by the caller and never sent to a server route.

import { bundleFromVault } from "./archive-builder.js";
import { deriveFamily } from "./kb-client-search.js";

/**
 * Convert a locally-built Classroom archive into the curated KB schema.
 *
 * `bundleFromVault` derives its course list from the NOTES, because that is all
 * a vault of markdown files gives it. A Classroom archive knows better: it
 * carries the courses the build actually saw, including ones that produced no
 * notes — a class with nothing posted in it yet, or one whose coursework fetch
 * failed and degraded gracefully to empty.
 *
 * Those have to survive the conversion. The "N new courses found in Google
 * Classroom" banner asks which courses the corpus has never seen, and a course
 * dropped here is missing from the corpus forever: the banner fires, "Update
 * now" rebuilds, the rebuild correctly adds no notes, and the banner returns.
 */
export function kbBundleFromClassroomArchive(archive) {
  const sourceNotes = Array.isArray(archive?.notes) ? archive.notes : [];
  const bundle = bundleFromVault(sourceNotes, {
    source: "classroom",
    archiveGeneratedAt: archive?.generatedAt || null,
  });

  const byName = new Map(bundle.courses.map((course) => [course.name, course]));
  for (const course of Array.isArray(archive?.courses) ? archive.courses : []) {
    // Entries are objects; a legacy archive stored bare strings.
    const name = String((typeof course === "string" ? course : course?.name) || "").trim();
    if (name && !byName.has(name)) byName.set(name, { name, y: null, family: null, noteCount: 0 });
  }

  return {
    ...bundle,
    source: "classroom",
    courses: [...byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((course) => ({ ...course, family: deriveFamily(course.name) })),
    notes: bundle.notes.map((note) => ({
      ...note,
      family: deriveFamily(note.course),
    })),
  };
}
