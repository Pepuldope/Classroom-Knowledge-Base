// kb-highlight.js — pure, DOM-free snippet highlighting for KB search results.
//
// highlightSnippet(text, query) returns HTML-safe markup with each query token
// (fuzzy-matched, mirroring kb-retrieval.js's stem rule) wrapped in <mark>.
// The input text is HTML-escaped first, so it is safe to inject via
// innerHTML after this call.

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Same fuzzy-stem rule as kb-retrieval.js tokenFuzzyMatch.
function fuzzyEqual(indexTok, queryTok) {
  if (indexTok === queryTok) return true;
  const minLen = Math.min(indexTok.length, queryTok.length);
  if (minLen < 4) return false;
  const stemLen = Math.min(6, minLen);
  return indexTok.slice(0, stemLen) === queryTok.slice(0, stemLen);
}

export function highlightSnippet(snippet, query) {
  const text = String(snippet || "");
  if (!text) return "";
  const qTokens = String(query || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  if (qTokens.length === 0) return escapeHtml(text);

  const escaped = escapeHtml(text);
  const lower = escaped.toLowerCase();
  const protectedSpans = []; // [start, end] already wrapped — avoid double wrap
  let result = "";
  let last = 0;
  const reToken = /[a-z0-9]+/g;
  let m;
  while ((m = reToken.exec(lower)) !== null) {
    const word = m[0];
    const matched = qTokens.some((qt) => fuzzyEqual(word, qt));
    if (!matched) continue;
    const start = m.index;
    const end = start + word.length;
    if (protectedSpans.some(([s, e]) => start < e && end > s)) continue;
    result += escaped.slice(last, start) + "<mark>" + escaped.slice(start, end) + "</mark>";
    protectedSpans.push([start, end]);
    last = end;
  }
  result += escaped.slice(last);
  return result;
}
