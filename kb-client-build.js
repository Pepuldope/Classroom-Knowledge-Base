// kb-client-build.js — pure transformations for the private browser-local KB.
// Classroom data is fetched by the caller and never sent to a server route.

import { bundleFromVault } from "./archive-builder.js";
import { deriveFamily } from "./kb-client-search.js";

/** Convert a locally-built Classroom archive into the curated KB schema. */
export function kbBundleFromClassroomArchive(archive) {
  const sourceNotes = Array.isArray(archive?.notes) ? archive.notes : [];
  const bundle = bundleFromVault(sourceNotes, {
    source: "classroom",
    archiveGeneratedAt: archive?.generatedAt || null,
  });
  return {
    ...bundle,
    source: "classroom",
    courses: bundle.courses.map((course) => ({
      ...course,
      family: deriveFamily(course.name),
    })),
    notes: bundle.notes.map((note) => ({
      ...note,
      family: deriveFamily(note.course),
    })),
  };
}
