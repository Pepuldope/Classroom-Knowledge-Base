// enrich-scope.js — which assignments are worth asking the AI about.
//
// This predicate lived inline in two different filters in app.js and was wrong
// in both, in ways that were invisible because nothing rendered a reason:
//
//   - loadReport only requested enrichment for isInScope() work, which
//     requires a due date inside -3..+7 days. Anything else was analyzed only
//     if the user expanded a collapsed section.
//   - the lazy pass then required isPending(), so a submitted assignment was
//     excluded from both paths and could never be analyzed at all — it showed
//     no type and no estimate for the rest of its life.
//
// Submitted work still deserves a type: "what kind of work was that" stays
// useful after it is handed in, even though "how long will it take" does not.
// Extracted here so the rule is stated once and can be tested without a
// browser.

/** Submission states that mean the student has handed the work in. */
export const SUBMITTED_STATES = ["TURNED_IN", "RETURNED"];

/** Whether a submission state means the work is done. */
export function isSubmittedState(state) {
  return SUBMITTED_STATES.includes(state);
}

/**
 * Whether an assignment should be sent for enrichment.
 *
 * Deliberately independent of due dates and of the showSubmitted display
 * preference: hiding completed work from a list is a display choice, and it
 * should not decide whether the work ever gets a type.
 */
export function isEnrichCandidate({
  kind,
  submissionState,
  stale = false,
  dismissed = false,
  hasEnrichment = false,
} = {}) {
  if (kind !== "assignment") return false;
  if (hasEnrichment) return false;
  // Long past its due date and still not handed in — analyzing it helps
  // nobody, and each call costs a request against a shared free quota.
  if (stale) return false;
  if (dismissed) return false;
  return true;
}
