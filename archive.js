// archive.js — shared note plumbing: markdown rendering and the IndexedDB
// primitives every local store is built on.
//
// This file used to own the Archive view: a second bundle, a second search
// index and a second related-notes scorer, all parallel to the Knowledge
// Base's. The Archive view is gone and its corpus was merged into the single
// Study corpus (kb-merge.js), so the bundle-specific half went with it —
// setArchive/getArchive, searchArchive, findRelated, buildIndex, scoreNotes and
// the import/persist/remove trio.
//
// What is left has real consumers and no duplicate: the markdown renderers
// (app.js, kb.js, kb_e2e_test.mjs) and idbGet/idbPut/idbDelete, which back
// kb-local.js and auth-session.js as well as the legacy-record migration below.
//
// The database is still named "cwa-archive" on purpose. Renaming it would
// orphan every existing user's notes for no functional gain.

// ---------------------------------------------------------------------------
// Text folding — shared by the markdown helpers and by callers that need a
// diacritic-insensitive key (app.js).
// ---------------------------------------------------------------------------

export function foldText(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ---------------------------------------------------------------------------
// Light, safe markdown rendering for note bodies (headings, bold, italics,
// inline code, lists, code fences). HTML is escaped first — this never does
// innerHTML of raw archive content.
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Only allow benign link protocols — never javascript:, data:, etc.
function safeHref(url) {
  const u = String(url).trim();
  if (/^(https?:|mailto:|obsidian:)/i.test(u)) return u;
  if (/^\//.test(u)) return u; // same-origin relative path
  return "#";
}

function inlineMd(s) {
  // Obsidian [[wikilinks]] -> safe <a class="wikilink">. Two forms:
  //   [[path|Label]]  -> shows Label (Label may itself contain a "|")
  //   [[a/b/c/Name]]  -> shows only the tail "Name" (the note name)
  // Source reaching inlineMd is ALREADY HTML-escaped by renderLightMarkdown
  // (a real "<" arrives as "&lt;"). To produce ONE correct level of escaping
  // (so the browser shows "<" as inert literal text, not a live tag, and not
  // the ugly double-escaped "&amp;lt;"), we decode the upstream entities back
  // to raw chars and re-escape once. This stays XSS-safe: any injected markup
  // becomes inert entities, and it is robust even if upstream escaping changes.
  let out = s.replace(/\[\[([^\]]+?)\]\]/g, (m, inner) => {
    const decode = (v) => String(v)
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const sep = inner.indexOf("|");
    const rawPath = (sep >= 0 ? inner.slice(0, sep) : inner).trim();
    const rawLabel = sep >= 0 ? inner.slice(sep + 1).trim() : rawPath.split("/").pop().trim();
    const disp = esc(decode(rawLabel || rawPath.split("/").pop().trim() || rawPath));
    return `<a class="wikilink" data-note="${disp}">${disp}</a>`;
  });
  // Markdown links [text](url) -> safe <a>. Must run BEFORE emphasis so the
  // URL's characters aren't mangled. The label may itself contain a bracketed
  // token (real teacher materials look like "[[Template] Worksheet](url)"), so
  // the label matcher tolerates ONE level of inner [brackets] — otherwise the
  // link fails to match and leaks as raw literal markdown text (owner #8/#10).
  out = out.replace(/\[((?:[^\]\[]|\[[^\]]*\])+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const href = safeHref(url);
    const label = text.replace(/</g, "&lt;");
    // title attribute = lightweight "preview" of where the link goes (no
    // server round-trip, no data leak). Neutralized links (href="#") skip it.
    const title = href === "#" ? "" : ` title="${href.replace(/"/g, "&quot;")}"`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer"${title}>${label}</a>`;
  });
  out = out
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  return out;
}

export function renderAssignmentDescription(text) {
  return renderRichMarkdown(text);
}

/** Render a small safe markdown subset of `text` to an HTML string. */
export function renderLightMarkdown(text) {
  const lines = escapeHtml(text == null ? "" : text).split("\n");
  let html = "";
  let inCode = false;
  let codeBuf = [];
  let listOpen = null; // 'ul' | 'ol' | null

  const closeList = () => { if (listOpen) { html += `</${listOpen}>`; listOpen = null; } };

  for (const raw of lines) {
    const fence = raw.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!inCode) { inCode = true; codeBuf = []; closeList(); }
      else { inCode = false; html += `<pre><code>${codeBuf.join("\n")}</code></pre>`; codeBuf = []; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`;
      continue;
    }

    const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listOpen !== "ol") { closeList(); html += "<ol>"; listOpen = "ol"; }
      html += `<li>${inlineMd(ol[1])}</li>`;
      continue;
    }
    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (listOpen !== "ul") { closeList(); html += "<ul>"; listOpen = "ul"; }
      html += `<li>${inlineMd(ul[1])}</li>`;
      continue;
    }

    closeList();
    if (raw.trim() === "") continue;
    html += `<p>${inlineMd(raw)}</p>`;
  }
  closeList();
  if (inCode && codeBuf.length) html += `<pre><code>${codeBuf.join("\n")}</code></pre>`;
  return html;
}

// Second rendering pass: handle the block-level constructs that the first
// light pass above deliberately skipped, so notes/assignments render richer
// formatting (tables, blockquotes, strikethrough) instead of leaking raw
// markdown.
//
// Safety: we re-run renderLightMarkdown first (which escapes HTML atomically
// per line and handles headings/lists/code/bold/inline-code/links), then apply
// the extra transforms on the ESCAPED output. The table/blockquote logic works
// on the ORIGINAL source lines so it can find table boundaries, but it only
// emits markup around already-escaped cell content — it never reintroduces raw
// user HTML, so this stays XSS-safe.
export function renderRichMarkdown(text) {
  const lines = (text == null ? "" : String(text)).split("\n");

  // GitHub-table detection runs on the ORIGINAL source lines so a stray "~" or
  // "|" inside other text can't be mis-parsed. A table is: a row line, followed
  // by a |---|---| separator, then body rows.
  const isSep = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
  const isRow = (l) => l.trim().startsWith("|") || l.includes(" | ");
  const cells = (l) =>
    l.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
      .split("|").map((c) => `<td>${inlineMd(escapeHtml(c.trim()))}</td>`).join("");
  const headCells = (l) =>
    l.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
      .split("|").map((c) => `<th>${inlineMd(escapeHtml(c.trim()))}</th>`).join("");

  // Obsidian callout: a blockquote whose first line is "> [!type]". The marker
  // itself (`[!type]`) must not leak as literal text — we strip it and wrap the
  // block in a styled <div class="callout callout-<type>"> with a small heading.
  const CALLOUT_RE = /^\s*>\s*\[!(\w[\w-]*)\]\s*(.*)$/;
  const isCalloutStart = (l) => CALLOUT_RE.test(l);

  // Apply the inline transforms (strikethrough + blockquote + callouts) to a
  // slice of the source. Each slice goes through renderLightMarkdown first, so
  // it is HTML-escaped (XSS-safe); we only upgrade the escaped output.
  // Consecutive non-table lines are batched so list runs stay contiguous
  // (one <ul>), not one list per line.
  const rich = (slice) => {
    const base = renderLightMarkdown(slice.join("\n"));
    return base
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/<p>&gt;\s?(.*?)<\/p>/g, "<blockquote>$1</blockquote>");
  };

  // Build a single callout block from its Obsidian source lines (the raw ">"
  // markers). Returns HTML. The block's body lines (after the [!type] marker
  // line) are re-rendered through `rich` so inline markdown inside the callout
  // still formats (<strong>, lists, etc.). The stylized title comes from the
  // marker's optional suffix ("> [!info] My title") or falls back to the
  // capitalized type — it is NOT duplicated into the body.
  const renderCallout = (calloutLines) => {
    const first = calloutLines.shift();
    const m = first.match(/^\s*>\s*\[!(\w[\w-]*)\]\s*(.*)$/);
    const type = (m && m[1]) || "note";
    const titleText = (m && m[2] && m[2].trim()) || type.charAt(0).toUpperCase() + type.slice(1);
    const bodySource = calloutLines.map((l) => l.replace(/^\s*>\s?/, ""));
    // rich() wraps EACH line in <p>…</p>; flatten to a single flow inside
    // .callout-body by joining paragraph breaks with <br> and dropping the
    // outer wrapper (avoids dangling </p><p> for multi-line callouts).
    const bodyHtml = rich(bodySource)
      .replace(/^<p>/, "")
      .replace(/<\/p>$/, "")
      .replace(/<\/p><p>/g, "<br>");
    return `<div class="callout callout-${type.toLowerCase()}">` +
      `<div class="callout-title">${escapeHtml(titleText)}</div>` +
      `<div class="callout-body">${bodyHtml}</div></div>`;
  };

  const out = [];
  let i = 0;
  let buf = [];
  const flush = () => { if (buf.length) { out.push(rich(buf)); buf = []; } };
  while (i < lines.length) {
    const l = lines[i];
    const next = lines[i + 1] || "";
    if (isRow(l) && isSep(next)) {
      // Header row at i, separator at i+1, body rows until a non-row/non-sep.
      out.push('<table class="md-table"><thead>');
      out.push(`<tr>${headCells(l)}</tr>`);
      out.push("</thead><tbody>");
      i += 2;
      while (i < lines.length && isRow(lines[i]) && !isSep(lines[i])) {
        out.push(`<tr>${cells(lines[i])}</tr>`);
        i++;
      }
      out.push("</tbody></table>");
      continue;
    }
    // Obsidian callout block: starts at a "> [!type]" line and continues across
    // consecutive "> ..." lines. Each line's leading "> " (escaped to "&gt; ")
    // is consumed by renderCallout; a blank line or a non-quote line ends it.
    if (isCalloutStart(l)) {
      const block = [l];
      i++;
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      out.push(renderCallout(block));
      continue;
    }
    // Non-table line (or a lone "| ..." that isn't a real table): render it
    // through the safe light pass + inline transforms on its own.
    out.push(rich([l]));
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// IndexedDB persistence (browser only — never referenced at module top level)
// ---------------------------------------------------------------------------

const DB_NAME = "cwa-archive";
const DB_VERSION = 1;
const STORE_NAME = "archive";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Legacy Archive records — read once, then deleted.
//
// Pre-merge builds stored the Archive corpus under "bundle" / "meta" in the
// same database. app.js folds it into the KB bundle on first load; these two
// helpers exist only for that migration and can go once no browser can still
// be carrying the old records.
// ---------------------------------------------------------------------------

/** The pre-merge Archive bundle, if this browser still has one. */
export async function loadLegacyArchiveBundle() {
  try {
    const record = await idbGet("bundle");
    return record && record.data ? record.data : null;
  } catch (e) {
    console.warn("[study] could not read the legacy archive record", e);
    return null;
  }
}

/** Drop the pre-merge records. Only called after the merged save succeeded. */
export async function removeLegacyArchiveBundle() {
  try { await idbDelete("bundle"); } catch {}
  try { await idbDelete("meta"); } catch {}
}
