// task-kinds.js — the fixed vocabulary of assignment types, shared by the
// server that produces them and the client that renders them.
//
// Shared on purpose. This list existed in three places at once — the prompt's
// prose, the server's validation, and the client's deriveLabel fallback — and
// they disagreed: the prompt offered "Question", so that is what came back,
// and the client independently produced it too. One array, imported by both
// sides, is the only arrangement where a kind cannot reappear after removal.
//
// Twelve plain nouns, chosen to read as something a student would actually
// say. A label nobody would use in conversation is worse than no label.

export const TASK_KINDS = [
  "Test",
  "Quiz",
  "Essay",
  "Project",
  "Reading",
  "Worksheet",
  "Practice",
  "Presentation",
  "Lab",
  "Video",
  "Notes",
  "Translation",
];

// Everything a model might say, mapped onto the twelve. Keys are lowercased,
// stripped of accents and then of non-letters before lookup, so "Problem Set",
// "problem-set" all land on "problemset" and "písomka" on "pisomka". Folding
// accents matters: stripping them as punctuation turned "písomka" into
// "psomka" and "slovíčka" into "slovka", which matched nothing.
//
// The retired kinds are here deliberately: enrichments cached before the list
// shrank still carry "Exam", "Report", "Problem set" and friends, and reading
// one back has to produce a current label rather than an empty card.
const SYNONYMS = {
  // -> Test
  exam: "Test",
  midterm: "Test",
  final: "Test",
  assessment: "Test",
  pisomka: "Test",
  skuska: "Test",
  maturita: "Test",
  previerka: "Test",
  // -> Quiz
  kviz: "Quiz",
  // -> Essay
  report: "Essay",
  analysis: "Essay",
  composition: "Essay",
  paper: "Essay",
  writing: "Essay",
  summary: "Essay",
  sloh: "Essay",
  uvaha: "Essay",
  // -> Project
  research: "Project",
  projekt: "Project",
  investigation: "Project",
  // -> Reading
  review: "Reading",
  revision: "Reading",
  article: "Reading",
  text: "Reading",
  chapter: "Reading",
  // -> Worksheet
  assignment: "Worksheet",
  homework: "Worksheet",
  task: "Worksheet",
  work: "Worksheet",
  handout: "Worksheet",
  form: "Worksheet",
  drawing: "Worksheet",
  sketch: "Worksheet",
  diagram: "Worksheet",
  // -> Practice
  question: "Practice",
  questions: "Practice",
  problem: "Practice",
  problems: "Practice",
  problemset: "Practice",
  exercise: "Practice",
  exercises: "Practice",
  drill: "Practice",
  vocabulary: "Practice",
  vocab: "Practice",
  wordlist: "Practice",
  slovicka: "Practice",
  listening: "Practice",
  // -> Presentation
  interview: "Presentation",
  speech: "Presentation",
  oral: "Presentation",
  viva: "Presentation",
  recording: "Presentation",
  discussion: "Presentation",
  debate: "Presentation",
  prezentacia: "Presentation",
  // -> Lab
  experiment: "Lab",
  practical: "Lab",
  pokus: "Lab",
  // -> Video
  film: "Video",
  movie: "Video",
  watch: "Video",
  // -> Notes
  note: "Notes",
  zosit: "Notes",
  // -> Translation
  translate: "Translation",
  preklad: "Translation",
};

// Last resort: read the assignment itself. Ordered most specific first.
const INFERENCE = [
  [/(písomk|pisomk|previerk|\btest\b|skúšk|skusk|maturit|exam)/, "Test"],
  [/(kvíz|kviz|\bquiz\b)/, "Quiz"],
  [/(esej|sloh|úvah|uvah|essay)/, "Essay"],
  [/(projekt|project)/, "Project"],
  [/(prezent|present)/, "Presentation"],
  [/(preklad|translat)/, "Translation"],
  [/(laborat|pokus|experiment|\blab\b)/, "Lab"],
  [/(video|film|pozri si)/, "Video"],
  [/(prečítaj|precitaj|čítan|citan|\bread\b|článok|clanok)/, "Reading"],
  [/(zošit|zosit|poznámk|poznamk|\bnotes?\b)/, "Notes"],
  [/(cvičen|cvicen|príklad|priklad|slovíčk|slovick|practice|exercise)/, "Practice"],
];

/** Lowercase and strip diacritics, so Slovak labels survive the a-z filter. */
function foldAccents(value) {
  return String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Force any label onto the canonical twelve.
 *
 * @param raw       whatever produced the label — a model, or a cached entry
 *                  written when the list was different.
 * @param haystack  assignment title + description, lowercased, used only when
 *                  the label itself is unusable.
 * @returns one of TASK_KINDS. Never "Assignment", "Task" or "Question": those
 *          name the format rather than the work and tell a student nothing.
 */
export function normalizeTaskKind(raw, haystack = "") {
  const s = String(raw ?? "").trim();

  const exact = TASK_KINDS.find((k) => k.toLowerCase() === s.toLowerCase());
  if (exact) return exact;

  const key = foldAccents(s).replace(/[^a-z]/g, "");
  if (key && SYNONYMS[key]) return SYNONYMS[key];

  // Test both the raw text and an accent-folded copy: the patterns below carry
  // both spellings, but folding also catches ones they miss.
  const text = String(haystack ?? "").toLowerCase();
  const folded = foldAccents(haystack ?? "");
  const inferred = INFERENCE.find(([re]) => re.test(text) || re.test(folded));
  if (inferred) return inferred[1];

  // The most common shape of school work, and a word that always reads fine.
  return "Worksheet";
}

/** True when a label is already one of the canonical kinds. */
export function isTaskKind(value) {
  return TASK_KINDS.includes(value);
}
