// kb-local.js — private, browser-local Knowledge Base persistence.
//
// Reuses archive.js's IndexedDB primitives and database instead of creating a
// second storage layer. The KB remains a distinct bundle under its own record
// IDs, so it cannot overwrite the raw Classroom archive.

import { idbGet, idbPut, idbDelete } from "./archive.js";

const BUNDLE_ID = "kb-bundle";
const META_ID = "kb-meta";

/** Validate the small public contract shared by KB ingestion and local storage. */
export function validateKbBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("KB bundle object required");
  }
  if (bundle.version !== 1) throw new Error("Unsupported KB bundle version 1 expected");
  if (!Array.isArray(bundle.notes)) throw new Error("KB bundle is missing its notes array");
  return bundle;
}

/** Save a validated KB bundle to the user's existing browser-local store. */
export async function saveKbBundle(bundle) {
  const valid = validateKbBundle(bundle);
  await idbPut({ id: BUNDLE_ID, data: valid });
  await idbPut({
    id: META_ID,
    noteCount: valid.notes.length,
    years: Array.isArray(valid.years) ? valid.years : [],
    generatedAt: valid.generatedAt || null,
    savedAt: new Date().toISOString(),
  });
  return valid;
}

/** Load the user's cached KB, if one exists. */
export async function loadKbBundle() {
  const record = await idbGet(BUNDLE_ID);
  return record?.data ? validateKbBundle(record.data) : null;
}

/** Remove only the local KB records; the raw archive remains untouched. */
export async function removeKbBundle() {
  await idbDelete(BUNDLE_ID);
  await idbDelete(META_ID);
}
