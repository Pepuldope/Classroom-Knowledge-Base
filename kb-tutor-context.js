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

// --- the student's current school year ------------------------------------
// Peter, 2026-09-13: "point me to my current year and not one i finished 2
// years ago". Asked about "my quiz next week from English", the tutor listed
// English quizzes from four classes across three years and asked which he
// meant — ELA Y3, BEng Y1, ELA 1 Gama, BEng Y2 — none of them this year's.

const yearStart = (y) => { const m = /^(\d{4})/.exec(String(y || "")); return m ? Number(m[1]) : null; };

/**
 * The school year the student is in: the one today falls in (a year runs from
 * August), when the notes have it, else the newest year they do have.
 */
export function currentSchoolYear(notes, today = new Date()) {
  const list = Array.isArray(notes) ? notes : [];
  const start = today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1;
  const label = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  let newest = null;
  for (const note of list) {
    if (note?.y === label) return label;
    if (yearStart(note?.y) != null && (newest == null || yearStart(note.y) > yearStart(newest))) newest = note.y;
  }
  return newest;
}

// An older note is let in beside current ones only when it is a near-exact
// match — re-learning linear functions from last year's notes is fine — and
// "near-exact" is measured against this year's best, not in absolute points,
// because scores depend on the corpus. Measured on the vault: a title match
// scores ~60-75, a passing mention under 35. "lineárna funkcia" found this
// year's "lineárne lomená funkcia" at 29.5 and last year's "Lineárna funkcia"
// at 72.7 (included); "kvadratická funkcia" found 72.6 this year and 69.7 last
// year (not included).
const NEAR_EXACT_OVER_CURRENT = 2;
const NEAR_EXACT_OF_BEST = 0.9;
const MAX_OLDER_BESIDE_CURRENT = 2;

export function buildTutorRetrievedNotes(bundle, query, { limit = DEFAULT_LIMIT, focusNote = null, currentYear = null, extraQuery = "" } = {}) {
  const notes = Array.isArray(bundle?.notes) ? bundle.notes : [];
  const numericLimit = Number(limit);
  const boundedLimit = Number.isFinite(numericLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(numericLimit)))
    : DEFAULT_LIMIT;
  if (!notes.length || !String(query || "").trim()) return [];

  // Search wider than we need when there is a focus or a year to prefer, so the
  // re-rank has candidates to promote rather than only the top few keyword hits.
  const searchLimit = focusNote || currentYear ? Math.min(notes.length, Math.max(boundedLimit * 5, 30)) : boundedLimit;
  const q = [tutorSearchQuery(query), tutorSearchQuery(extraQuery)].filter(Boolean).join(" ");
  const hits = searchNotes(notes, q, { limit: searchLimit }).map((result) => ({
    ...notes[result.noteIndex],
    noteIndex: result.noteIndex,
    _score: result._score,
  }));
  const strip = ({ _score, ...note }) => note;
  if (!currentYear) return rankByCourseAffinity(hits, focusNote).slice(0, boundedLimit).map(strip);

  const current = hits.filter((n) => n.y === currentYear);
  const older = hits.filter((n) => n.y !== currentYear);
  if (!current.length) return rankByCourseAffinity(older, focusNote).slice(0, boundedLimit).map(strip);

  const bestCurrent = Math.max(...current.map((n) => n._score));
  const best = Math.max(bestCurrent, ...older.map((n) => n._score));
  // When the question is about a class this year (a note is open, or it named a
  // Planner item) and this year's notes from that class matched, older years
  // stay out: last year's "Vocabulary quiz" is exactly the wrong answer to
  // "what is on my quiz".
  const focusCourse = String(focusNote?.course || "").trim().toLowerCase();
  const focusCovered = focusCourse && current.some((n) => String(n.course || "").trim().toLowerCase() === focusCourse);
  const nearExact = focusCovered ? [] : older
    .filter((n) => n._score >= bestCurrent * NEAR_EXACT_OVER_CURRENT && n._score >= best * NEAR_EXACT_OF_BEST)
    .slice(0, MAX_OLDER_BESIDE_CURRENT);
  const ranked = rankByCourseAffinity(current, focusNote).slice(0, boundedLimit - nearExact.length);
  return [...ranked, ...nearExact].map(strip);
}

// --- the student's pending work --------------------------------------------
// The tutor had no idea what was on the student's Planner, so "my quiz next
// week" meant nothing to it. The Planner's pending work is sent with every
// question; this picks the item a question is about, so retrieval can look in
// that class and the prompt can name it.

const SUBJECTS = [
  { ask: /\b(english|anglick\w*|anglin\w*|angli\w*|ela|eng)\b/, course: /\b(ela|eng\w*|beng|aj)\b/i },
  { ask: /\b(slovak|slovensk\w*|slovin\w*|sjl|kuj)\b/, course: /\b(sjl|slov\w*|kuj)\b/i },
  { ask: /\b(maths?|matik\w*|matematik\w*|mat)\b/, course: /\b(mat\w*|math\w*)\b/i },
  { ask: /\b(physics|fyzik\w*)\b/, course: /fyz|phys/i },
  { ask: /\b(chemistry|chemi\w*)\b/, course: /chem/i },
  { ask: /\b(biology|biologi\w*)\b/, course: /bio/i },
  { ask: /\b(databases?|databaz\w*|sql)\b/, course: /datab/i },
  { ask: /\b(programming|programovani\w*|prog)\b/, course: /prog|digi/i },
  { ask: /\b(business|podnikani\w*|pak)\b/, course: /business|pak|podnik|nae/i },
  { ask: /\b(history|dejepis\w*|glost|global studies)\b/, course: /glost|dejep|hist/i },
];
const KINDS = /\b(quiz\w*|test\w*|exam\w*|pisomk\w*|skusk\w*|assessment|essay|esej\w*|homework|du|ulohy?|presentation|prezentac\w*|project|projekt\w*)\b/g;
const WEEKDAYS = [
  /\b(sunday|nedel\w*)\b/, /\b(monday|pondel\w*)\b/, /\b(tuesday|utor\w*)\b/, /\b(wednesday|stred\w*)\b/,
  /\b(thursday|stvrt\w*)\b/, /\b(friday|piatok|piatk\w*)\b/, /\b(saturday|sobot\w*)\b/,
];
const kindRoot = (word) => {
  const w = passageFold(word);
  if (/^(quiz|test|exam|pisomk|skusk|assessment)/.test(w)) return "test";
  if (/^(essay|esej)/.test(w)) return "essay";
  if (/^(homework|du$|uloh)/.test(w)) return "homework";
  if (/^(presentation|prezentac)/.test(w)) return "presentation";
  if (/^(project|projekt)/.test(w)) return "project";
  return w;
};
const kindsIn = (text) => new Set((passageFold(text).match(KINDS) || []).map(kindRoot));

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
}

/**
 * Rank pending work against a question. Returns the candidates with a positive
 * score, best first, and `match` when one is clearly the one meant.
 *
 * A subject the question names is a filter, not a hint: "from English" rules
 * out a maths quiz however well its date fits. A time phrase ("next week",
 * "tomorrow", "on Tuesday") and a kind of work ("quiz", "essay") add weight.
 */
export function matchPendingWork(question, work = [], today = new Date().toISOString().slice(0, 10)) {
  const q = passageFold(question);
  const items = Array.isArray(work) ? work : [];
  const subjects = SUBJECTS.filter((s) => s.ask.test(q));
  const askedKinds = kindsIn(q);
  const weekday = WEEKDAYS.findIndex((re) => re.test(q));
  const time = /\b(tomorrow|zajtra)\b/.test(q) ? "tomorrow"
    : /\b(today|dnes)\b/.test(q) ? "today"
      : /\b(next week|buduci tyzden|dalsi tyzden)\b/.test(q) ? "next-week"
        : /\b(this week|tento tyzden)\b/.test(q) ? "this-week"
          : weekday >= 0 ? "weekday" : "";
  const words = new Set(tutorSearchQuery(question).split(/\s+/).map(passageFold).filter((w) => w.length > 2));

  const scored = [];
  for (const item of items) {
    const course = String(item?.course || "");
    const title = String(item?.title || "");
    if (!title) continue;
    if (subjects.length && !subjects.some((s) => s.course.test(course))) continue;
    let score = subjects.length ? 3 : 0;
    const itemKinds = kindsIn(`${title} ${item.description || ""}`);
    for (const k of askedKinds) if (itemKinds.has(k)) score += 2;
    for (const w of passageFold(`${title} ${course}`).match(/[a-z0-9]+/g) || []) if (words.has(w)) score += 1;
    const days = item.dueDate ? daysBetween(today, item.dueDate) : null;
    if (time && days != null) {
      const dueDay = new Date(`${item.dueDate}T00:00:00Z`).getUTCDay();
      const fits = time === "today" ? days === 0
        : time === "tomorrow" ? days === 1
          : time === "this-week" ? days >= 0 && days <= 7
            : time === "next-week" ? days >= 1 && days <= 14
              : dueDay === weekday && days >= 0 && days <= 7;
      // A named day that does not fit rules the item out; a week is looser.
      if (!fits && (time === "today" || time === "tomorrow" || time === "weekday")) continue;
      score += fits ? 2 : -2;
    }
    if (score > 0) scored.push({ ...item, score, days });
  }
  scored.sort((a, b) => b.score - a.score || (a.days ?? 999) - (b.days ?? 999));
  const [first, second] = scored;
  const clear = first && first.score >= 3 && (!second || first.score > second.score);
  return { candidates: scored.slice(0, 5), match: clear ? first : null };
}
