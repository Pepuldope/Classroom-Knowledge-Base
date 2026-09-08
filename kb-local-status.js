const CLEARED_MESSAGE = "Your local knowledge base was cleared and is now empty. Build it again from Google Classroom when ready.";
const SENSITIVE_CHECKPOINT_KEY = /authorization|headers?|token|(?:^|[_-])auth(?:$|[_-])|api[_-]?key|cookie|secret/i;

function stripSensitiveCheckpointFields(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveCheckpointFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_CHECKPOINT_KEY.test(key))
    .map(([key, nested]) => [key, stripSensitiveCheckpointFields(nested)]));
}

export function kbLocalStatusModel(state = "") {
  if (state === "cleared") return { message: CLEARED_MESSAGE, tone: "polite", focusTarget: "kbBuildBtn" };
  return { message: "", tone: "polite" };
}

export function kbBuildProgressStatusModel({ message = "", done = 0, total = 0 } = {}) {
  const label = String(message || "Building your knowledge base…").trim();
  const count = Number.isFinite(done) && Number.isFinite(total) && total > 0
    ? ` (${Math.max(0, Math.floor(done))} of ${Math.floor(total)} courses)`
    : "";
  return { message: `${label}${count}`, tone: "polite", live: "polite" };
}

/** Normalize a resumable, token-free Classroom build checkpoint. */
export function kbBuildCheckpointModel(input = null) {
  const courses = Array.isArray(input?.courses)
    ? input.courses.filter((course) => course && course.id).map(({ id, name, section, description, ownerId, creationTime }) => ({
      id: String(id),
      ...(name ? { name: String(name) } : {}),
      ...(section ? { section: String(section) } : {}),
      ...(description ? { description: String(description) } : {}),
      ...(ownerId ? { ownerId: String(ownerId) } : {}),
      ...(creationTime ? { creationTime: String(creationTime) } : {}),
    }))
    : [];
  const sourceData = input?.courseData && typeof input.courseData === "object" && !Array.isArray(input.courseData)
    ? input.courseData
    : {};
  const courseData = Object.fromEntries(Object.entries(sourceData).filter(([id, value]) =>
    courses.some((course) => course.id === id) && value && typeof value === "object" && !Array.isArray(value),
  ).map(([id, value]) => [id, stripSensitiveCheckpointFields(value)]));
  return {
    version: 1,
    courses,
    courseData,
    completedCourseIds: courses.filter((course) => courseData[course.id]).map((course) => course.id),
    showBuildCard: courses.length === 0 || Object.keys(courseData).length === 0,
  };
}

/** Summarize resumable progress without including assignment or note content. */
export function kbBuildResumeSummaryModel(input = null) {
  const checkpoint = kbBuildCheckpointModel(input);
  const completedCourses = checkpoint.courses.filter((course) => checkpoint.courseData[course.id]);
  const names = completedCourses.map((course) => course.name || course.id).slice(0, 3);
  const remaining = Math.max(0, checkpoint.courses.length - completedCourses.length);
  const preview = names.join(", ");
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return {
    completed: completedCourses.length,
    total: checkpoint.courses.length,
    names,
    remaining,
    label: `Completed ${completedCourses.length} of ${checkpoint.courses.length} courses${preview ? `: ${preview}` : ""}${suffix}.`,
  };
}

/**
 * How long an interrupted build stays resumable.
 *
 * A checkpoint holds the full raw Classroom payload for every course completed
 * so far — coursework, materials, announcements and submissions — so an
 * abandoned build leaves a second copy of most of the corpus in IndexedDB with
 * nothing to ever clear it. It is also the kind of data that goes off: resuming
 * a fortnight-old checkpoint ingests a fortnight-old Classroom.
 */
export const KB_CHECKPOINT_MAX_AGE_DAYS = 7;

/** True when a stored checkpoint is too old to resume from (or undatable). */
export function isStaleKbBuildCheckpoint(savedAt, now = new Date().toISOString(), maxAgeDays = KB_CHECKPOINT_MAX_AGE_DAYS) {
  const saved = Date.parse(String(savedAt || ""));
  const current = Date.parse(String(now || ""));
  // An undated checkpoint predates this field; treat it as stale rather than
  // keeping it forever.
  if (!Number.isFinite(saved)) return true;
  if (!Number.isFinite(current)) return false;
  const ageDays = (current - saved) / 86_400_000;
  // A clock that moved backwards is not evidence of freshness.
  return !(ageDays >= 0 && ageDays < maxAgeDays);
}
