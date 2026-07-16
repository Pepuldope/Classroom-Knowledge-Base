// kb-retrieval.js — pure, DOM-free retrieval over the shared knowledge base.
// Mirrors the scoring in archive.js (title×5, summary×3, body×1, +2 when all
// query tokens appear) so behaviour matches the original planner's "From your
// archive" strip, but operates on an EXTERNAL notes array rather than the
// module-global `archive`, so it can search a private browser-local bundle.

function foldText(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
const TOKEN_RE = /[a-z0-9]+/g;
function tokenize(s) {
  return foldText(s).match(TOKEN_RE) || [];
}
function tokenFuzzyMatch(indexToken, queryToken) {
  if (indexToken === queryToken) return true;
  const minLen = Math.min(indexToken.length, queryToken.length);
  if (minLen < 4) return false;
  const stemLen = Math.min(6, minLen);
  return indexToken.slice(0, stemLen) === queryToken.slice(0, stemLen);
}
function buildIndex(notes) {
  const index = new Map();
  const add = (tok, field, i) => {
    let entry = index.get(tok);
    if (!entry) {
      entry = { title: new Set(), summary: new Set(), body: new Set(), course: new Set(), topic: new Set() };
      index.set(tok, entry);
    }
    entry[field].add(i);
  };
  notes.forEach((n, i) => {
    for (const tok of tokenize(n.t)) add(tok, "title", i);
    if (n.s) for (const tok of tokenize(n.s)) add(tok, "summary", i);
    if (n.x) for (const tok of tokenize(n.x)) add(tok, "body", i);
    if (n.course) for (const tok of tokenize(n.course)) add(tok, "course", i);
    if (n.topic) for (const tok of tokenize(n.topic)) add(tok, "topic", i);
  });
  return index;
}
const FIELD_WEIGHT = { title: 5, summary: 3, body: 1, course: 4, topic: 4 };

function scoreNotes(notes, qTokens) {
  const idx = buildIndex(notes);
  const scores = new Map();
  for (const qt of qTokens) {
    for (const [tok, fields] of idx) {
      if (!tokenFuzzyMatch(tok, qt)) continue;
      for (const field of ["title", "summary", "body", "course", "topic"]) {
        const weight = FIELD_WEIGHT[field];
        for (const i of fields[field]) {
          let rec = scores.get(i);
          if (!rec) { rec = { score: 0, matched: new Set() }; scores.set(i, rec); }
          rec.score += weight;
          rec.matched.add(qt);
        }
      }
    }
  }
  const results = [];
  for (const [i, rec] of scores) {
    let score = rec.score;
    if (rec.matched.size === qTokens.length) score += 2;
    results.push({ index: i, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
function findMatchPos(text, qTokens) {
  const folded = foldText(text);
  const re2 = /[a-z0-9]+/g; let m;
  while ((m = re2.exec(folded))) { for (const qt of qTokens) if (tokenFuzzyMatch(m[0], qt)) return m.index; }
  return -1;
}
const SNIPPET_LEN = 200;
function buildSnippet(note, qTokens) {
  const source = note.x || note.s || "";
  if (!source) return "";
  const pos = findMatchPos(source, qTokens);
  if (pos === -1) return source.length > SNIPPET_LEN ? source.slice(0, SNIPPET_LEN).trim() + "…" : source.trim();
  const start = Math.max(0, pos - 50);
  const end = Math.min(source.length, start + SNIPPET_LEN);
  let snippet = source.slice(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < source.length) snippet += "…";
  return snippet;
}

// Sort strategies for the KB result set (focus area 7). `relevance` (default)
// keeps the existing score ordering. The others reorder the MATCHED notes by a
// stable secondary key. Exported + pure for unit testing.
export function makeSortFn(sort) {
  switch (sort) {
    case "recency":
      // Newest year first (string year sorts lexicographically — already works
      // for "2025-26" > "2024-25" > "2023-24"; "undated" sinks). Ties broken by
      // the relevance score so a newer-year tie still ranks by match quality.
      const undated = (value) => !value || String(value).toLowerCase() === "undated";
      const byDate = (value) => undated(value) ? "" : String(value);
      return (a, b) =>
        (undated(a.y) ? 1 : 0) - (undated(b.y) ? 1 : 0) ||
        byDate(b.y).localeCompare(byDate(a.y)) ||
        (b._score || 0) - (a._score || 0);
    case "title":
      return (a, b) => String(a.t || "").localeCompare(String(b.t || ""));
    case "course":
      return (a, b) =>
        String(a.course || "").localeCompare(String(b.course || "")) ||
        String(a.t || "").localeCompare(String(b.t || ""));
    case "relevance":
    default:
      // Relevance: by score desc (searchNotes already sorts, but we keep a
      // deterministic tiebreak by course then title for stable output).
      return (a, b) =>
        (b._score || 0) - (a._score || 0) ||
        String(a.course || "").localeCompare(String(b.course || "")) ||
        String(a.t || "").localeCompare(String(b.t || ""));
  }
}

/**
 * Search the shared KB. Returns top `limit` notes with _score and _snippet.
 * Each returned note also carries t/s/course/y/topic/p so the frontend and
 * the tutor can cite the source.
 */
export function searchNotes(notes, query, { limit = 8, requireTitleOrSummary = false, sortFn = null, indexMap = null } = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored = scoreNotes(notes, qTokens);
  const out = [];
  for (const { index, score } of scored) {
    const n = notes[index];
    const snippet = buildSnippet(n, qTokens);
    if (requireTitleOrSummary) {
      const hitInTitleOrSummary =
        tokenFuzzyAny(n.t, qTokens) || (n.s && tokenFuzzyAny(n.s, qTokens));
      if (!hitInTitleOrSummary) continue;
    }
    out.push({
      t: n.t || "",
      course: n.course || "",
      y: n.y || "",
      topic: n.topic || null,
      p: n.p || "",
      noteIndex: Array.isArray(indexMap) && indexMap[index] != null ? indexMap[index] : index,
      _score: score,
      _snippet: snippet,
    });
  }
  // Explicit sort order (focus area 7): when a sortFn is supplied it reorders
  // the complete matched set before the limit is applied, so title/course/
  // recency sorts cannot lose a better-ordered result that ranked lower.
  if (typeof sortFn === "function") out.sort(sortFn);
  return out.slice(0, limit);
}

function tokenFuzzyAny(text, qTokens) {
  const toks = tokenize(text);
  return qTokens.some((qt) => toks.some((it) => tokenFuzzyMatch(it, qt)));
}

// Common classroom/English stopwords. These appear in every note (announcements,
// "please submit on Classroom", "thank you for your attention") so raw token
// overlap would let a giant boilerplate "Announcements" note score hundreds of
// points against unrelated notes and crowd out genuine cross-links. Filtered
// out of the related-notes overlap signal only (search keeps them).
const RELATED_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "of", "to", "in", "on",
  "for", "with", "as", "is", "are", "was", "were", "be", "been", "being", "this", "that",
  "these", "those", "it", "its", "we", "you", "your", "our", "they", "them", "their",
  "he", "she", "his", "her", "i", "me", "my", "at", "by", "from", "up", "out", "do",
  "does", "did", "has", "have", "had", "will", "would", "can", "could", "should",
  "may", "might", "please", "thank", "thanks", "note", "notes", "class", "classes",
  "classroom", "student", "students", "teacher", "assignment", "assignments", "course",
  "school", "lesson", "lessons", "work", "works", "hello", "hi", "dear", "use", "using",
  "will", "not", "no", "yes", "so", "just", "more", "also", "about", "into", "than",
  "then", "them", "there", "here", "what", "when", "where", "which", "who", "why", "how",
  "all", "any", "each", "every", "other", "some", "such", "only", "own", "same", "can",
  "new", "one", "two", "get", "make", "made", "see", "like", "time", "first", "last",
  // Slovak stopwords (the vault has many Slovak-language courses).
  "a", "na", "s", "v", "je", "do", "sa", "že", "pre", "zo", "od", "k", "i", "u", "o",
  "tento", "táto", "toto", "ten", "tá", "to", "tieto", "tie", "ktorý", "ktorá", "ktoré",
  "sme", "ste", "si", "tu", "tam", "ako", "ked", "keď", "ale", "len", "už", "ešte",
  "všetko", "vše", "každý", "každá", "každé", "svoj", "svoje", "svoju", "možno", "treba",
  "pri", "pod", "nad", "za", "po", "vy", "via", "viac", "menej", "veľmi", "celý", "celá",
  "jeho", "jej", "ich", "ním", "nou", "čo", "kto", "kde", "kedy", "prečo", "ak", "keby",
]);

// Strip URL-fragment tokens (https, com, google, drive, usp, web, mdexmde…)
// that appear in every "Announcements" boilerplate and would otherwise create
// false overlap. Anything that looks like a hostname/link artifact is dropped.
function isUrlToken(t) {
  return /^(https?|com|www|google|drive|docs|usp|web|mdexmde|mtm|nje|beta|flexiquiz|memrise|open|link|classroom)$/.test(t);
}

// Filter the stopword set + URL fragments from a token array (stable, case-insensitive).
function dropStopwords(tokens) {
  return tokens.filter((t) => !RELATED_STOPWORDS.has(t) && !isUrlToken(t));
}

/**
 * Find notes related to a given target note. A note relates if it shares the
 * target's course, shares its topic, or contains overlapping query tokens from
 * the target's title/summary/body. The target itself is never returned.
 * Results are ranked (course/topic first, then token overlap) and capped to
 * `limit`. Each result carries the same shape as searchNotes so the UI can
 * reuse the same rendering (t, course, y, topic, p, noteIndex, _score, _snippet).
 */
export function relatedNotes(notes, target, { limit = 5 } = {}) {
  // Course-wide "Announcements" bulletins are structural boilerplate (a
  // different post for every course) — they share only generic Classroom
  // phrasing with everything and are never genuinely "related content".
  // Exclude them so they can't crowd out real cross-links (owner request #9).
  const isBulletin = (n) => {
    const t = (n && n.t) || "";
    return /(^|\s)[-–]?\s*announcements?\s*$/i.test(t) || /^announcements?$/i.test(t);
  };
  const scored = [];
  // Drop stopwords from the target's tokens so common Classroom phrasing
  // ("please submit the assignment on Classroom") can't produce false overlap
  // with boilerplate. Specific vocabulary ("quantum", "entanglement") survives.
  const targetTokens = dropStopwords(tokenize([target.t, target.s, target.x].filter(Boolean).join(" ")));
  const targetCourse = target.course || "";
  const targetTopic = target.topic || "";

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n === target) continue; // never relate a note to itself (reference)
    if (isBulletin(n)) continue; // skip course bulletins — not related content
    let score = 0;
    if (targetCourse && n.course === targetCourse) score += 3;
    if (targetTopic && n.topic && n.topic === targetTopic) score += 3;
    // Exact token overlap with the target's own text (fast + precise). Both
    // sides are stopword-filtered so boilerplate can't inflate the score.
    if (targetTokens.length) {
      const nTokens = dropStopwords(tokenize([n.t, n.s, n.x].filter(Boolean).join(" ")));
      let overlap = 0;
      for (const t of nTokens) if (targetTokens.includes(t)) overlap++;
      score += overlap;
    }
    if (score <= 0) continue; // unrelated — skip
    scored.push({ index: i, score, note: n });
  }

  // Rank by score, then by stable index for deterministic output.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const out = [];
  const snippetTokens = targetTokens.length ? targetTokens : [];
  for (const { index, score, note } of scored) {
    out.push({
      t: note.t || "",
      course: note.course || "",
      y: note.y || "",
      topic: note.topic || null,
      p: note.p || "",
      noteIndex: index,
      _score: score,
      _snippet: buildSnippet(note, snippetTokens),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Compact related-notes preview for a note by its bundle index. Thin wrapper
 * over relatedNotes() so the search-results surface can render the same
 * cross-links the note-detail modal shows. Returns the same shape
 * (t, course, y, topic, p, noteIndex, _score, _snippet). The note itself is
 * never included (relatedNotes already excludes the reference note).
 */
export function relatedNotesPreview(notes, index, opts = {}) {
  if (!Array.isArray(notes) || !Number.isInteger(index) || index < 0 || index >= notes.length) return [];
  const target = notes[index];
  if (!target) return [];
  return relatedNotes(notes, target, opts);
}

// ---------------------------------------------------------------------------
// "Did you mean" typo-tolerance.
// Build the shared vocabulary of all index tokens so we can find a confident
// near-miss when a query token is spelled wrong.
// ---------------------------------------------------------------------------
function collectVocabulary(notes) {
  const set = new Set();
  for (const n of notes) {
    for (const tok of tokenize([n.t, n.s, n.x].filter(Boolean).join(" "))) set.add(tok);
  }
  return set;
}

// Standard Levenshtein edit distance (small strings only — query tokens).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

// Find the single best confident correction for a non-matching query token.
// Returns null when no confident near-miss exists (so we never false-suggest).
function bestCorrection(qt, vocab) {
  const maxDist = qt.length <= 4 ? 0 : qt.length <= 6 ? 1 : 2;
  let best = null, bestDist = Infinity;
  for (const tok of vocab) {
    if (Math.abs(tok.length - qt.length) > maxDist + 1) continue;
    const d = levenshtein(qt, tok);
    if (d > maxDist) continue;
    // Require first-character agreement for non-trivial edits to avoid wild
    // swaps (e.g. "cat" -> "act"); trivial single-edit swaps are allowed.
    if (d > 1 && tok[0] !== qt[0]) continue;
    if (d < bestDist) { bestDist = d; best = tok; }
  }
  return best;
}

/**
 * Suggest a corrected spelling for a query that returns no matches.
 * Returns a corrected query string (e.g. "mitochondria") when the original
 * misses but a confident edit-distance near-miss exists in the corpus AND the
 * corrected query actually yields results. Returns null when the query already
 * matches, when there's no confident correction, or when the correction would
 * still produce nothing (so we never show a useless "did you mean").
 *
 * Reuses searchNotes() so the suggestion is always grounded in real results.
 */
export function suggestCorrection(notes, query) {
  if (!Array.isArray(notes) || notes.length === 0) return null;
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return null;
  // Already matches something — no suggestion.
  if (searchNotes(notes, query, { limit: 1 }).length > 0) return null;
  const vocab = collectVocabulary(notes);
  if (vocab.size === 0) return null;
  const corrected = [];
  for (const qt of qTokens) {
    let matched = false;
    for (const tok of vocab) { if (tokenFuzzyMatch(tok, qt)) { matched = true; break; } }
    if (matched) { corrected.push(qt); continue; }
    const cand = bestCorrection(qt, vocab);
    if (!cand) return null; // unresolvable token -> no suggestion at all
    corrected.push(cand);
  }
  const correctedQuery = corrected.join(" ");
  if (correctedQuery === qTokens.join(" ")) return null;
  // Only suggest if the corrected query actually finds something.
  if (searchNotes(notes, correctedQuery, { limit: 1 }).length === 0) return null;
  return correctedQuery;
}

export function deriveFamily(course = "") {
  const c = String(course || "");
  const rules = [
    [/beng|b\.?eng|engineering/i, "Engineering"],
    [/digi|datab[aá]zy|informat|computer|program/i, "Digital/IT"],
    [/ela|english|jazyk|kuj|sloven|language/i, "Language"],
    [/fyzika|physics|chem|biol|math|matemat|maturita/i, "Science/Math"],
    [/glo|geograf|hist|dejepis|spolo|humanit/i, "Humanities"],
    [/business|ekonom|strateg/i, "Business"],
    [/bud[uú]cnos?[ťt]|future|career|kari[eé]r/i, "Careers"],
    [/v[šs]?pv|u[cč]itel|pedagog/i, "Teaching"],
    [/šport|sport|telocvik|\bpe\b/i, "PE"],
    [/v[ýy]tvar|hudob|hudba|art|music|drama/i, "Arts"],
  ];
  for (const [re, family] of rules) if (re.test(c)) return family;
  return "";
}
