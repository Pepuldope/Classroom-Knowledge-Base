// assignment-panel.js — what the assignment panel says, before anything draws it.
//
// The panel's context block used to be built inline in `openAi` as a list of
// HTML fragments joined with `<br>`: course, due date, a Classroom link, the
// one-line summary, an in-person note, a materials strip and the original
// description, all run together inside a 200px scroller that its own content
// always overflowed. Seven different kinds of fact separated by line breaks is
// not a layout, and none of it could be tested without a browser.
//
// So the facts come out here as structure, and app.js decides how they look.

/** Minutes as something a person says out loud. */
export function estimateLabel(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 60) return `${Math.round(n)}m`;
  const hours = Math.floor(n / 60);
  const rest = Math.round(n % 60);
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * The panel's facts, in the order they should be read.
 *
 * `facts` are the short labelled ones that belong on a chip row; `summary` and
 * `note` are sentences; the rest tells the renderer which optional blocks to
 * build at all. Nothing here is HTML — escaping is the renderer's job, and
 * doing it here is what made the old version impossible to test.
 */
export function assignmentPanelModel({
  courseName = "",
  dueLabel = "",
  submitted = false,
  enrichment = null,
  materials = [],
  description = "",
  link = "",
  creationTime = "",
  updateTime = "",
} = {}) {
  const e = enrichment && typeof enrichment === "object" ? enrichment : {};
  const facts = [];
  const course = String(courseName || "").trim();
  if (course) facts.push({ key: "course", label: "Course", value: course });
  const due = String(dueLabel || "").trim();
  if (due) facts.push({ key: "due", label: "Due", value: due });
  const estimate = estimateLabel(e.estimatedMinutes);
  if (estimate) facts.push({ key: "estimate", label: "Est.", value: estimate });
  const kind = String(e.taskKind || "").trim();
  if (kind) facts.push({ key: "kind", label: "Type", value: kind });
  if (submitted) facts.push({ key: "state", label: "Status", value: "Submitted" });

  const list = Array.isArray(materials) ? materials.filter(Boolean) : [];
  return {
    facts,
    summary: String(e.oneLineSummary || "").trim(),
    // The one action-type worth a sentence: it changes what the student does.
    // The rest ("submit_online") is the default and says nothing.
    note: e.actionType === "in_person" ? "In-person task — nothing to upload" : "",
    materials: list,
    materialCount: list.length,
    hasDescription: Boolean(String(description || "").trim()),
    link: String(link || "").trim(),
    posted: postedModel({ creationTime, updateTime }),
  };
}

/** A day apart is a real edit; minutes apart is Classroom saving the same post. */
const POSTED_EDIT_MS = 24 * 60 * 60 * 1000;

/**
 * When this was put up, and whether it has been changed since.
 *
 * The panel said what the assignment is and when it is due but never when it
 * appeared, which is the fact you want when you are deciding whether you have
 * already seen something — and the fact you need to tell "this is genuinely
 * new" from "this has been sitting there for a week". Dates, not strings: the
 * renderer owns the reader's locale.
 *
 * `updated` only survives when the edit is at least a day after the post.
 * Classroom stamps `updateTime` on its own saves, so without that floor almost
 * every item would claim to have been "updated" a minute after it was posted.
 */
export function postedModel({ creationTime = "", updateTime = "" } = {}) {
  const postedAt = toDate(creationTime);
  if (!postedAt) return { postedAt: null, updatedAt: null, showUpdated: false };
  const updatedAt = toDate(updateTime);
  const showUpdated = Boolean(updatedAt) && updatedAt - postedAt >= POSTED_EDIT_MS;
  return { postedAt, updatedAt: showUpdated ? updatedAt : null, showUpdated };
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The one line that says what the tutor can see.
 *
 * This replaced a 171px tinted box that restated the panel header (the title),
 * the fact row (the course) and the materials strip (every attachment, again,
 * as "Sources: …") directly underneath all three. On a 776px phone sheet that
 * box plus the context above it left 139px for the actual conversation.
 */
export function groundingLineModel({ materialCount = 0 } = {}) {
  const n = Number(materialCount) || 0;
  return n > 0
    ? `Reading this assignment and its ${n} attachment${n === 1 ? "" : "s"}`
    : "Reading this assignment";
}
