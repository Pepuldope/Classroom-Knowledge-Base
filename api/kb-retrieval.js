// kb-retrieval.js — pure, DOM-free retrieval over the shared knowledge base.
// Mirrors the scoring in archive.js (title×5, summary×3, body×1, +2 when all
// query tokens appear) so behaviour matches the original planner's "From your
// archive" strip, but operates on an EXTERNAL notes array rather than the
// module-global `archive`, so it can search the server-side safekeep.

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
    if (!entry) { entry = { title: new Set(), summary: new Set(), body: new Set() }; index.set(tok, entry); }
    entry[field].add(i);
  };
  notes.forEach((n, i) => {
    for (const tok of tokenize(n.t)) add(tok, "title", i);
    if (n.s) for (const tok of tokenize(n.s)) add(tok, "summary", i);
    if (n.x) for (const tok of tokenize(n.x)) add(tok, "body", i);
  });
  return index;
}
const FIELD_WEIGHT = { title: 5, summary: 3, body: 1 };

function scoreNotes(notes, qTokens) {
  const idx = buildIndex(notes);
  const scores = new Map();
  for (const qt of qTokens) {
    for (const [tok, fields] of idx) {
      if (!tokenFuzzyMatch(tok, qt)) continue;
      for (const field of ["title", "summary", "body"]) {
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

/**
 * Search the shared KB. Returns top `limit` notes with _score and _snippet.
 * Each returned note also carries t/s/course/y/topic/p so the frontend and
 * the tutor can cite the source.
 */
export function searchNotes(notes, query, { limit = 8, requireTitleOrSummary = false } = {}) {
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
      _score: score,
      _snippet: snippet,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function tokenFuzzyAny(text, qTokens) {
  const toks = tokenize(text);
  return qTokens.some((qt) => toks.some((it) => tokenFuzzyMatch(it, qt)));
}
