// related-materials.js — find the Classroom material a task is talking about.
//
// The tutor said this, unprompted and correctly:
//
//   "The assignment says the materials are in your Classroom folders, but
//    there are no attachments listed on this assignment."
//
// Both halves are true, and together they are the gap. Teachers routinely post
// the handout as a separate Classroom item and then write "see the folder" on
// the assignment, so the thing the student needs is sitting in the same course,
// posted the same week, with a closely related title — and nothing connected
// the two, because Classroom's own data does not.
//
// So we infer the link. Same course is required; after that it is title overlap
// and how close the two were posted, which is exactly how a person would find
// it by eye. Everything here is a GUESS and the prompt says so — the tutor may
// point at these, never assert they are the required reading.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "is", "are",
  "with", "your", "you", "this", "that", "from", "by", "it", "as", "be", "will",
  // Classroom's own boilerplate: these match everything and mean nothing.
  "quiz", "test", "assignment", "homework", "task", "material", "materials",
  "worksheet", "notes", "lesson", "class", "week", "part", "ga",
]);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Past this, "posted around the same time" stops meaning anything. */
export const NEAR_IN_DAYS = 21;

export function titleTokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
}

function daysApart(a, b) {
  const ta = Date.parse(a || ""), tb = Date.parse(b || "");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb) / DAY_MS;
}

/**
 * Score one candidate against the open item. Null means "not a candidate".
 *
 * The weights encode what actually identifies a handout. A shared distinctive
 * word ("stereometry", "Macbeth") is the strongest signal there is, which is
 * why the stopword list above strips the words that appear on every third
 * Classroom post — without it "Vocabulary quiz" matches every vocabulary quiz
 * ever set, which is the failure mode this whole area keeps returning to.
 */
export function scoreRelatedMaterial(item, candidate) {
  if (!item || !candidate) return null;
  if (candidate.id && item.id && candidate.id === item.id) return null;
  // Same course is required, not scored. A handout from another class is not a
  // weaker match, it is a wrong answer.
  const sameCourse = candidate.courseId && item.courseId
    ? candidate.courseId === item.courseId
    : String(candidate.courseName || "") === String(item.courseName || "");
  if (!sameCourse) return null;
  // Announcements are chatter, not material a student studies from.
  if (candidate.kind === "announcement") return null;

  const shared = overlap(titleTokens(item.title), titleTokens(candidate.title));
  const gap = daysApart(item.creationTime, candidate.creationTime);
  const near = gap == null ? 0 : Math.max(0, 1 - gap / NEAR_IN_DAYS);

  let score = shared * 3 + near * 2;
  // "The materials are in the Classroom folders" means a material, not another
  // assignment — so a material of equal textual similarity should win.
  if (candidate.kind === "material") score += 1;
  const topic = String(item.enrichment?.topic || "").toLowerCase();
  if (topic && String(candidate.enrichment?.topic || "").toLowerCase() === topic) score += 1;

  // A candidate that shares nothing but a course and a rough date is noise.
  // Requiring one real signal is what keeps this from listing the whole term.
  if (shared === 0 && near < 0.55) return null;
  return {
    score,
    why: [
      shared > 0 ? "similar title" : "",
      gap != null && near > 0 ? (gap < 1 ? "posted the same day" : `posted ${Math.round(gap)} day(s) apart`) : "",
      candidate.kind === "material" ? "class material" : "",
    ].filter(Boolean).join(", "),
  };
}

/**
 * The material in this class that the open item is probably referring to.
 *
 * Ranked, capped, and never presented as certain — see the prompt block in
 * api/tutor.js, which labels these as guesses the tutor may point at.
 */
export function relatedCourseMaterials(item, all, { limit = 5 } = {}) {
  const candidates = Array.isArray(all) ? all : [];
  const scored = [];
  for (const candidate of candidates) {
    const result = scoreRelatedMaterial(item, candidate);
    if (!result) continue;
    scored.push({ item: candidate, ...result });
  }
  return scored
    .sort((a, b) => b.score - a.score || String(a.item.title || "").localeCompare(String(b.item.title || "")))
    .slice(0, Math.max(0, limit))
    .map(({ item: candidate, why }) => ({
      title: String(candidate.title || "Untitled"),
      kind: candidate.kind === "material" ? "material" : "assignment",
      link: String(candidate.alternateLink || ""),
      postedAt: String(candidate.creationTime || "").slice(0, 10),
      why,
    }));
}
