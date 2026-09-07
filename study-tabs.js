// study-tabs.js — which panel of the Study page is showing.
//
// The Study page replaced two separate top-level pages (Archive and Knowledge
// Base) that each had their own way to find a note. Folding them together only
// helps if the result is one page with one clear place for each job, so the
// panels are mutually exclusive and the model is pure — the previous
// subview toggle lived inline in a DOM function and could not be tested.

export const STUDY_TABS = ["search", "browse", "curriculum", "manage"];
export const DEFAULT_STUDY_TAB = "search";

/**
 * Resolve a requested tab into the full visible/hidden state.
 *
 * Unknown or missing values fall back to Search rather than leaving the page
 * with nothing showing.
 */
export function studyTabModel(requested) {
  const active = STUDY_TABS.includes(requested) ? requested : DEFAULT_STUDY_TAB;
  return {
    active,
    panels: STUDY_TABS.map((tab) => ({ tab, hidden: tab !== active })),
  };
}

/**
 * Which tab a given action should land on.
 *
 * Typing a query while on Browse or Curriculum should show the results, not
 * silently search a panel the user cannot see.
 */
export function studyTabForAction(action, current) {
  if (action === "search") return "search";
  if (action === "open-course") return "browse";
  return STUDY_TABS.includes(current) ? current : DEFAULT_STUDY_TAB;
}
