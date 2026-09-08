// route-transition.js — focus restoration when moving between Planner and Study.
//
// Extracted from kb.js so that app.js does not have to import it. These three
// functions were the ONLY thing the Planner needed from the Study module, and
// that single import pulled kb.js and its whole subtree — the search index, the
// Classroom builder, the curriculum matrix, the local store — onto the critical
// path of every page load, including loads that never open Study.

/** Return the destination nav target that should regain focus after a KB modal closes. */
export function kbViewTransitionFocusTargetModel({ from = "", to = "", modalWasOpen = false } = {}) {
  if (from !== "kb" || !modalWasOpen || !["planner", "archive"].includes(to)) return null;
  return to;
}

/** Describe route-transition focus restoration without persisting or exposing note content. */
export function kbViewTransitionFocusAnnouncementModel(view = "") {
  const labels = { planner: "Planner", archive: "Archive" };
  const label = labels[view];
  if (!label) return null;
  return {
    role: "status",
    live: "polite",
    atomic: "true",
    text: `${label} view opened. Focus restored to ${label} navigation.`,
  };
}

/**
 * Keep route-transition focus markers in the UI-only channel. Unknown text is
 * discarded so note bodies or other private content cannot be persisted or
 * accidentally included in a tutor request by future callers.
 */
export function routeTransitionFocusPrivacyModel(text = "") {
  const allowed = new Set([
    kbViewTransitionFocusAnnouncementModel("planner")?.text,
    kbViewTransitionFocusAnnouncementModel("archive")?.text,
  ]);
  const safeText = allowed.has(String(text)) ? String(text) : "";
  return { storage: null, tutor: null, text: safeText };
}
