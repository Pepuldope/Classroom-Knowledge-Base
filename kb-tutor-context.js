// Pure browser-side grounding selection for the KB tutor.
// Only notes selected by local retrieval cross the tutor request boundary.

import { searchNotes } from "./kb-client-search.js";

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 8;
const MAX_FIELD_LENGTHS = Object.freeze({
  t: 300,
  course: 160,
  y: 40,
  topic: 160,
  // Same numbers as NOTE_SUMMARY_MAX / NOTE_BODY_MAX in api/tutor.js. On the
  // real vault, 1,400 characters of passages carried 54% of the lines that
  // matched a question; 2,200 carries 64%, still under the 24,000-char payload.
  s: 500,
  x: 2200,
});

/**
 * Strip source-only fields and cap each retrieved note before JSON serialization.
 * The server applies the same bounds defensively, but the browser should avoid
 * sending oversized bodies across the privacy boundary in the first place.
 *
 * With a `query`, a long body is cut to the passages that match it rather than
 * to its first 1,400 characters — see notePassages.
 */
export function tutorRequestNotesModel(notes, { query = "" } = {}) {
  if (!Array.isArray(notes)) return [];
  return notes.slice(0, MAX_LIMIT).map((note) => {
    const bounded = {};
    for (const [field, maxLength] of Object.entries(MAX_FIELD_LENGTHS)) {
      if (typeof note?.[field] !== "string") continue;
      bounded[field] = field === "x"
        ? notePassages(note[field], query, maxLength)
        : note[field].slice(0, maxLength);
    }
    if (Number.isInteger(note?.noteIndex)) bounded.noteIndex = note.noteIndex;
    return bounded;
  });
}

// --- passages ---------------------------------------------------------------
// The tutor used to receive each note's first 1,400 characters. For a long note
// that is usually its header and a list of Drive links, and the paragraph that
// actually answers the question sits further down, unsent — so the tutor could
// neither quote it nor know it existed, and filled the gap from general
// knowledge. The same budget now goes to the parts of the note that match.

const PASSAGE_TARGET = 420;
const PASSAGE_GAP = "\n[…]\n";
const passageFold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const PASSAGE_STOP = new Set(["the", "and", "for", "are", "was", "what", "how", "why", "who", "when", "which", "this", "that", "with", "from", "about", "does", "can", "you", "your", "explain", "tell", "give", "please", "mean", "means", "aky", "ako", "preco", "kedy", "este", "alebo", "ktory", "ktora", "je", "su", "na", "pre"]);

function passageTerms(query) {
  const terms = (passageFold(query).match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 2 && !PASSAGE_STOP.has(t) && !/^\d+$/.test(t));
  return [...new Set(terms)];
}

/** Paragraphs, with any long one cut at line or sentence breaks near PASSAGE_TARGET. */
function passageBlocks(text) {
  const blocks = [];
  let offset = 0;
  for (const para of text.split(/\n\s*\n/)) {
    const start = text.indexOf(para, offset);
    offset = start + para.length;
    if (!para.trim()) continue;
    let from = 0;
    while (para.length - from > PASSAGE_TARGET * 1.5) {
      const window = para.slice(from, from + PASSAGE_TARGET * 1.5);
      const cut = Math.max(window.lastIndexOf("\n", PASSAGE_TARGET * 1.2), window.lastIndexOf(". ", PASSAGE_TARGET * 1.2) + 1);
      const end = cut > PASSAGE_TARGET * 0.5 ? cut : PASSAGE_TARGET;
      blocks.push({ start: start + from, text: para.slice(from, from + end) });
      from += end;
    }
    blocks.push({ start: start + from, text: para.slice(from) });
  }
  return blocks;
}

/**
 * The parts of `text` that best match `query`, within `budget` characters, in
 * document order, with "[…]" where text was skipped.
 *
 * A body within budget is returned whole. With no query, or nothing matching,
 * this is the old behaviour — the opening of the note — because then the
 * opening is as good a guess as any.
 */
export function notePassages(text, query = "", budget = 1400) {
  const body = typeof text === "string" ? text : "";
  if (body.length <= budget) return body;
  const terms = passageTerms(query);
  const head = () => body.slice(0, budget);
  if (!terms.length) return head();

  const blocks = passageBlocks(body).map((block, index) => {
    const folded = passageFold(block.text);
    let score = 0;
    for (const term of terms) {
      if (folded.includes(term)) {
        const hits = folded.split(term).length - 1;
        score += 1 + Math.min(hits - 1, 3) * 0.25;
      } else if (term.length >= 6 && folded.includes(term.slice(0, 5))) {
        score += 0.4; // "funkcia" / "funkcie", "equation" / "equations"
      }
    }
    return { ...block, index, score };
  });
  if (!blocks.some((b) => b.score > 0)) return head();

  const chosen = [];
  let used = 0;
  for (const block of [...blocks].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (block.score <= 0) break;
    const cost = Math.min(block.text.length, budget) + PASSAGE_GAP.length;
    if (used + cost > budget) {
      if (chosen.length) continue;
      chosen.push({ ...block, text: block.text.slice(0, budget - PASSAGE_GAP.length) });
      break;
    }
    chosen.push(block);
    used += cost;
  }
  chosen.sort((a, b) => a.start - b.start);
  let out = chosen[0].start > 0 ? PASSAGE_GAP.trimStart() : "";
  chosen.forEach((block, i) => {
    if (i > 0) {
      const prev = chosen[i - 1];
      // Neighbouring blocks were one paragraph; only mark text actually skipped.
      out += block.start - (prev.start + prev.text.length) > 2 ? PASSAGE_GAP : "\n\n";
    }
    out += block.text.trim();
  });
  return out.slice(0, budget);
}

// --- checking the tutor's quotes -------------------------------------------
// The prompt tells the model to quote exactly and cite [n]. Telling is not
// checking: a free model will happily put quotation marks round a paraphrase.
// This looks for each quoted span in the note it cites — the WHOLE note from
// the local bundle, not the excerpt that was sent — and reports the ones it
// cannot find, so a made-up quote is visible instead of authoritative.

const QUOTE_RE = /["\u201c\u201e]([^"\u201c\u201d\u201e\n]{12,400})["\u201d\u201c]\s*((?:\[\d{1,2}\][\s,]*)+)/g;
const quoteFold = (s) => passageFold(s).replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which quotes in `answer` appear in the notes they cite.
 *
 * `sources[n - 1]` is the full text of note [n] (title, summary and body
 * joined), or null when [n] was not sent. Returns every quote with `found`, so
 * the UI can say "2 quotes checked" as well as flag the ones that failed.
 */
export function verifyTutorQuotes(answer, sources = []) {
  const text = typeof answer === "string" ? answer : "";
  const folded = (Array.isArray(sources) ? sources : []).map((s) => (typeof s === "string" ? quoteFold(s) : null));
  const quotes = [];
  for (const match of text.matchAll(QUOTE_RE)) {
    const quote = match[1].trim();
    const cites = [...match[2].matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
    const needle = quoteFold(quote);
    // A quote this short after folding ("x = 2") proves nothing either way.
    if (needle.length < 8) continue;
    const found = cites.some((n) => folded[n - 1] && folded[n - 1].includes(needle));
    quotes.push({ quote, cites, found });
  }
  return {
    quotes,
    checked: quotes.length,
    missing: quotes.filter((q) => !q.found),
  };
}

const fold = (value) => String(value || "").trim().toLowerCase();

/**
 * Prefer notes from the class the student is actually in.
 *
 * Lexical search alone answered "what do I need to know for this quiz?" with
 * five vocabulary quizzes from four different classes across three school
 * years, because "vocabulary quiz" matches all of them equally well. When
 * something is open, its course and topic are the strongest signal available
 * about which of those the student means — stronger than any keyword in the
 * question, which is usually a generic word like "quiz" or "this".
 *
 * A stable partition, not a filter: other-course notes keep their relevance
 * order and stay available, they just stop outranking the student's own class.
 * Filtering them out would break the genuine case of a topic taught in two
 * subjects.
 */
export function rankByCourseAffinity(results, focusNote) {
  const course = fold(focusNote?.course);
  const topic = fold(focusNote?.topic);
  const year = fold(focusNote?.y);
  if (!course && !topic) return results;
  const rank = (note) => {
    // Same class AND same year is the student's current course; same class in
    // an earlier year is still theirs, and still better than a stranger's.
    let score = 0;
    if (course && fold(note?.course) === course) score += year && fold(note?.y) === year ? 4 : 3;
    if (topic && fold(note?.topic) === topic) score += 2;
    return score;
  };
  return results
    .map((result, i) => ({ result, i, rank: rank(result) }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .map(({ result }) => result);
}

// Words a student uses to ASK, not to say what about. Search scored them like
// any other: "Čo je diskriminant a ako ho vypočítam? Odcituj moje poznámky."
// returned "MacBook Welcome" first and missed "Všeobecný vzorec a diskriminant",
// which "diskriminant" alone ranks top by a wide margin. Folded (no diacritics).
const QUESTION_WORDS = new Set([
  // English
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "for", "to", "from", "with", "about", "into", "by",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "can", "could", "would", "should", "will",
  "i", "me", "my", "mine", "you", "your", "it", "its", "this", "that", "these", "those", "there", "here",
  "what", "whats", "which", "who", "how", "why", "when", "where", "please", "pls",
  "explain", "tell", "say", "says", "said", "show", "give", "find", "quote", "cite", "summarize", "summarise",
  "describe", "define", "mean", "means", "meaning", "help", "understand", "know", "need",
  "note", "notes", "material", "materials", "class", "according", "using", "only", "knowledge", "base",
  "topic", "like", "im", "starting", "zero", "simple", "words",
  // Slovak
  "co", "je", "su", "som", "si", "sa", "a", "aj", "ale", "alebo", "ako", "ho", "ju", "ich", "mu", "mi", "ma", "to", "ten", "ta",
  "moje", "moja", "moj", "mojich", "mojej", "tvoje", "na", "v", "vo", "z", "zo", "o", "pre", "pri", "do", "od", "k", "ku", "s", "so",
  "aky", "aka", "ake", "preco", "kedy", "kde", "ktory", "ktora", "ktore", "kolko",
  "vysvetli", "povedz", "ukaz", "daj", "najdi", "odcituj", "cituj", "citat", "zhrn", "prosim", "mam", "mozes", "podla",
  "poznamky", "poznamka", "poznamok", "poznamkach", "material", "materialy", "materialov", "hodina", "hodiny", "nieco", "vsetko",
]);

/**
 * The part of a student's question worth searching for.
 *
 * Falls back to the whole question when every word is a question word
 * ("explain this"), because an empty query retrieves nothing at all.
 */
export function tutorSearchQuery(text) {
  const raw = String(text || "");
  const words = raw.match(/[\p{L}\p{N}]+/gu) || [];
  const content = words.filter((w) => !QUESTION_WORDS.has(passageFold(w)));
  return content.length ? content.join(" ") : raw.trim();
}

export function buildTutorRetrievedNotes(bundle, query, { limit = DEFAULT_LIMIT, focusNote = null } = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const numericLimit = Number(limit);
  const boundedLimit = Number.isFinite(numericLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(numericLimit)))
    : DEFAULT_LIMIT;
  if (!notes.length || !String(query || "").trim()) return [];

  // Search wider than we need when there is a focus, so the re-rank has
  // same-course candidates to promote rather than only the top few keyword
  // hits — which is exactly the set that was all from the wrong classes.
  const searchLimit = focusNote ? Math.min(notes.length, boundedLimit * 4) : boundedLimit;
  const hits = searchNotes(notes, tutorSearchQuery(query), { limit: searchLimit }).map((result) => ({
    ...notes[result.noteIndex],
    noteIndex: result.noteIndex,
  }));
  return rankByCourseAffinity(hits, focusNote).slice(0, boundedLimit);
}
