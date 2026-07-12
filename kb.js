// kb.js — Knowledge Base ("safekeep") view + AI tutor.
//
// Self-contained module. It does NOT reach into app.js internals; it only
// reuses the already-initialized Google token client (window.__cwaTokenClient)
// and the shared CLIENT_ID. The Planner and Archive views keep working
// exactly as before.
//
// Public surface used:
//   - accessToken (app.js global) — current Google OAuth access token
//   - window.__cwaTokenClient — the google.accounts.oauth2 token client
//   - getOauthConfig() / storeUserSub() — from app.js (auth state)
//
// Backend endpoints (see api/):
//   POST /api/kb-scrape   { source:'classroom', authToken } | { source:'bundle', bundle }
//   GET  /api/kb-search?q=  -> { meta, results:[{t,course,y,topic,p,_score,_snippet}] }
//   POST /api/tutor        { messages:[...] }  (streaming SSE, uses DB context)

import { highlightSnippet } from "./kb-highlight.js";
import { renderLightMarkdown } from "./archive.js";

const $ = (id) => document.getElementById(id);
const KB_TOKEN_KEY = "cwa_kb_token";
export { highlightSnippet, bundleToMarkdown, bundleToCsv };

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------
export function showKbView() {
  wireKbEvents(); // ensure search/tutor listeners are attached (idempotent)
  const v = $("kbView");
  if (!v) return;
  v.hidden = false;
  refreshKb();
}

// Planner→KB bridge: jump from an assignment straight into a KB search for its
// topic. `topic` is a free-text query (e.g. the assignment title or course).
// Switches to the KB view, prefills the search box, and runs the search.
export function kbSearchTopic(topic) {
  const t = (topic || "").trim();
  showKbView();
  const input = $("kbSearchInput");
  if (input) {
    input.value = t;
    runKbSearch(t);
  } else {
    refreshKb();
  }
}

async function refreshKb() {
  const onboarding = $("kbOnboarding");
  const main = $("kbMain");
  const buildPanel = $("kbBuildPanel");
  let meta = null;
  try {
    const r = await fetch("/api/kb-search?q=" + encodeURIComponent("__ping__"));
    if (r.ok) { const d = await r.json(); meta = d.meta; }
  } catch {}
  const hasDb = !!(meta && meta.noteCount > 0);
  if (onboarding) onboarding.hidden = hasDb && !buildPanel.hidden ? false : hasDb;
  // If a DB exists, show the main search/tutor surface; else show onboarding.
  if (main) main.hidden = !hasDb;
  if (onboarding) onboarding.hidden = hasDb;
  if (hasDb) {
    renderKbMeta(meta);
    // Fresh load (no active query yet) → surface the discovery panel so the
    // KB isn't blank below the search box. A real query hides it via runKbSearch.
    const search = $("kbSearchInput");
    if (!search || !search.value.trim()) showBrowsePanel();
  }
}

function renderKbMeta(meta) {
  const bar = $("kbMetaBar");
  if (!bar || !meta) return;
  const yrs = Array.isArray(meta.years) && meta.years.length ? meta.years.join(", ") : "—";
  const updated = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : (meta.generatedAt ? new Date(meta.generatedAt).toLocaleString() : "unknown");
  bar.innerHTML = `<span>📚 <strong>${meta.noteCount?.toLocaleString() ?? 0}</strong> notes</span>` +
    `<span>🏫 ${meta.courses ?? 0} courses</span>` +
    `<span>📅 ${yrs}</span>` +
    `<span>🕑 updated ${updated}</span>`;
}

// ---------------------------------------------------------------------------
// Result-count summary (ROADMAP #55): build the human "Showing N of M notes"
// line the UI shows above the results, plus the active-filter annotation that
// makes the "clear filters" control meaningful. Pure + exported for unit tests.
// ---------------------------------------------------------------------------
export function buildResultSummary({ shown, total, course = "", year = "" }) {
  const unit = total === 1 ? "note" : "notes";
  const filters = [];
  if (course) filters.push(`course: ${course}`);
  if (year) filters.push(`year: ${year}`);
  const base = `Showing ${shown} of ${total} ${unit}`;
  return filters.length ? `${base} (filtered by ${filters.join(", ")})` : base;
}

// ---------------------------------------------------------------------------
// Export (public — the shared DB is readable by anyone, no login required)
// ---------------------------------------------------------------------------
function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFilename(ext) {
  const d = new Date().toISOString().slice(0, 10);
  return `classroom-kb-${d}.${ext}`;
}

function escapeCsvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function bundleToMarkdown(bundle) {
  const notes = Array.isArray(bundle.notes) ? bundle.notes : [];
  const lines = ["# Classroom Knowledge Base Export", ""];
  if (bundle.generatedAt) lines.push(`_Generated: ${new Date(bundle.generatedAt).toLocaleString()}_`, "");
  if (notes.length) lines.push(`_${notes.length} notes_`, "");
  // Group by course.
  const byCourse = new Map();
  for (const n of notes) {
    const c = n.course || "Uncategorised";
    if (!byCourse.has(c)) byCourse.set(c, []);
    byCourse.get(c).push(n);
  }
  for (const [course, ns] of byCourse) {
    lines.push(`## ${course}`, "");
    for (const n of ns) {
      const head = [n.t || "Untitled", n.y ? `(${n.y})` : "", n.topic ? `— ${n.topic}` : ""].filter(Boolean).join(" ");
      lines.push(`### ${head}`, "");
      // Derived summary (the ×3-weighted field) — front and centre.
      if (n.s) lines.push(`> ${n.s}`, "");
      if (Array.isArray(n.tags) && n.tags.length) lines.push(`*Tags: ${n.tags.join(", ")}*`, "");
      if (n.p) lines.push(`_Source: ${n.p}_`, "");
      const body = (n.x || "").trim();
      if (body) lines.push("", body);
      lines.push("", "---", "");
    }
  }
  return lines.join("\n");
}

function bundleToCsv(bundle) {
  const notes = Array.isArray(bundle.notes) ? bundle.notes : [];
  const rows = [["title", "course", "year", "topic", "tags", "summary", "body", "path"]];
  for (const n of notes) {
    rows.push([
      n.t || "",
      n.course || "",
      n.y || "",
      n.topic || "",
      Array.isArray(n.tags) ? n.tags.join("; ") : "",
      n.s || "",
      n.x || "",
      n.p || "",
    ].map(escapeCsvCell));
  }
  return rows.map((r) => r.join(",")).join("\n");
}

async function exportKb(format) {
  const status = $("kbExportStatus");
  const setStatus = (msg, isError) => {
    if (!status) return;
    status.textContent = msg;
    status.hidden = false;
    status.classList.toggle("error", !!isError);
  };
  setStatus("Preparing…");
  try {
    const r = await fetch("/api/kb-store?action=export");
    if (!r.ok) throw new Error(`export failed (${r.status})`);
    const data = await r.json();
    const bundle = data.bundle;
    if (!bundle || !Array.isArray(bundle.notes) || bundle.notes.length === 0) {
      setStatus("Nothing to export yet — the knowledge base is empty.", true);
      return;
    }
    if (format === "json") {
      downloadFile(exportFilename("json"), JSON.stringify(bundle, null, 2), "application/json");
    } else if (format === "md") {
      downloadFile(exportFilename("md"), bundleToMarkdown(bundle), "text/markdown");
    } else if (format === "csv") {
      downloadFile(exportFilename("csv"), bundleToCsv(bundle), "text/csv");
    }
    setStatus(`Exported ${bundle.notes.length} notes.`);
  } catch (err) {
    setStatus("Export failed: " + (err.message || err), true);
  }
}



// ---------------------------------------------------------------------------
// Tutor source attribution — turn the notes the RAG tutor actually used into
// clickable chip descriptors the UI renders. Each chip keeps the note index so
// a click can open the full note in the detail modal (openKbNote).
// ---------------------------------------------------------------------------
export function tutorSourceList(notes) {
  if (!Array.isArray(notes)) return [];
  const seen = new Set();
  const out = [];
  for (const n of notes) {
    if (!n || n.noteIndex === undefined || n.noteIndex === null) continue;
    if (seen.has(n.noteIndex)) continue; // de-dupe by index
    seen.add(n.noteIndex);
    out.push({
      noteIndex: n.noteIndex,
      title: n.t || "(untitled)",
      subtitle: [n.course, n.y].filter(Boolean).join(" · "),
    });
  }
  return out;
}
let _kbWired = false;
export function wireKbEvents() {
  if (_kbWired) return; // idempotent — safe to call multiple times
  _kbWired = true;
  const buildBtn = $("kbBuildBtn");
  const fileLink = $("kbLoadFileLink");
  const fileInput = $("kbFileInput");
  const tutorOpen = $("kbTutorOpen");
  const tutorClose = $("kbTutorClose");
  const tutorForm = $("kbTutorForm");
  const tutorInput = $("kbTutorInput");

  buildBtn?.addEventListener("click", () => startScrape());
  fileLink?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", (e) => handleKbFile(e));

  tutorOpen?.addEventListener("click", () => { const m = $("kbTutorModal"); if (m) m.hidden = false; });
  tutorClose?.addEventListener("click", () => { const m = $("kbTutorModal"); if (m) m.hidden = true; });
  tutorForm?.addEventListener("submit", (e) => { e.preventDefault(); const v = tutorInput?.value.trim(); if (v) sendTutor(v); });
  document.querySelectorAll("#kbTutorModal .ai-quick button").forEach((b) =>
    b.addEventListener("click", () => { const p = b.dataset.prompt; if (p) sendTutor(p); })
  );

  // Note-detail modal (opened by clicking a result card).
  $("kbNoteClose")?.addEventListener("click", closeKbNote);
  $("kbNoteCloseBtn")?.addEventListener("click", closeKbNote);

  const search = $("kbSearchInput");
  search?.addEventListener("input", debounce(() => runKbSearch(search.value), 200));

  // Browse-by-course: "back to all courses" returns to the course grid.
  $("kbBrowseBack")?.addEventListener("click", () => {
    const notesEl = $("kbBrowseNotes");
    if (notesEl) notesEl.hidden = true;
    loadBrowseCourses();
    const back = $("kbBrowseBack");
    if (back) back.hidden = true;
  });

  // Keyboard shortcuts (agent-proposed backlog):
  //   "/"  -> focus the KB search box from anywhere in the view.
  //   Esc  -> clear the search box (and its results) when it's focused.
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable);
    if (e.key === "/" && !typing) {
      const box = $("kbSearchInput");
      if (box) { e.preventDefault(); box.focus(); }
    } else if (e.key === "Escape" && e.target && e.target.id === "kbSearchInput") {
      e.target.value = "";
      runKbSearch("");
    }
  });

  // Export controls (public — the shared DB is readable by anyone).
  $("kbExportJson")?.addEventListener("click", () => exportKb("json"));
  $("kbExportMd")?.addEventListener("click", () => exportKb("md"));
  $("kbExportCsv")?.addEventListener("click", () => exportKb("csv"));
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// accessToken lives in app.js's module scope; read it via the window mirror it
// exposes (window.__cwaAccessToken). Fall back to our own cached token.
function currentAccessToken() {
  return (typeof window !== "undefined" && window.__cwaAccessToken) || loadKbToken() || null;
}

async function startScrape() {
  const panel = $("kbBuildPanel");
  const statusEl = $("kbBuildStatus");
  const showStatus = (msg, isError) => {
    if (panel) panel.hidden = false;
    if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("error", !!isError); }
  };

  const accessToken = currentAccessToken();
  if (!accessToken) {
    // Need a fresh Classroom token with the read-only scopes.
    if (!window.__cwaTokenClient) {
      showStatus("Sign in with Google first (use the top-right button), then try again.", true);
      console.warn("[KB] startScrape: no token and no Google token client available.");
      return;
    }
    window.__cwaTokenClient.callback = (resp) => {
      if (resp.error) { showStatus("Google sign-in failed: " + resp.error, true); return; }
      accessToken = resp.access_token;
      storeKbToken(resp.access_token, Number(resp.expires_in) || 3600);
      doScrape(resp.access_token);
    };
    try {
      // prompt:'' reuses the silent/consent flow; note: scopes here MUST include
      // the Classroom read-only set (see SCOPES in app.js / index.html preconnect).
      window.__cwaTokenClient.requestAccessToken({ prompt: "" });
    } catch (e) { showStatus("Could not start Google sign-in: " + e.message, true); }
    return;
  }
  doScrape(accessToken || loadKbToken());
}

async function doScrape(token) {
  const panel = $("kbBuildPanel");
  const statusEl = $("kbBuildStatus");
  const logEl = $("kbBuildLog");
  const progress = $("kbBuildProgressBar");
  if (panel) panel.hidden = false;
  if (statusEl) { statusEl.textContent = "Reading your courses…"; statusEl.classList.remove("error"); }
  if (logEl) logEl.innerHTML = "";
  if (progress) progress.style.width = "5%";
  const log = (msg) => { if (logEl) { const li = document.createElement("div"); li.textContent = msg; logEl.appendChild(li); } };

  const authHdr = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  try {
    // Step 1: list courses (bounded, fast).
    const listRes = await fetch("/api/kb-scrape", {
      method: "POST",
      headers: authHdr,
      body: JSON.stringify({ source: "classroom", mode: "list", authToken: token }),
    });
    if (!listRes.ok) { const e = await listRes.json().catch(() => ({})); setKbBuildError(e.error || listRes.status); return; }
    const list = await listRes.json();
    const courses = list.courses || [];
    if (courses.length === 0) { if (statusEl) statusEl.textContent = "✅ No courses found to scrape."; return; }
    if (statusEl) statusEl.textContent = `Scraping ${courses.length} course${courses.length === 1 ? "" : "s"} into the shared DB…`;

    // Step 2: per-course, incremental save so a single slow/failed course can't
    // 504 the whole scrape and partial progress is preserved.
    let done = 0, failed = 0;
    for (const c of courses) {
      try {
        const r = await fetch("/api/kb-scrape", {
          method: "POST",
          headers: authHdr,
          body: JSON.stringify({ source: "classroom", mode: "course", courseId: c.id, authToken: token }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        done++;
        log(`✓ ${c.name || c.id} — ${d.notes} notes`);
      } catch (err) {
        failed++;
        log(`✗ ${c.name || c.id} — ${err.message}`);
      }
      if (progress) progress.style.width = `${Math.round(((done + failed) / courses.length) * 100)}%`;
    }

    if (statusEl) {
      statusEl.textContent = failed === 0
        ? `✅ Saved ${done} course${done === 1 ? "" : "s"} to the shared knowledge base.`
        : `⚠️ Saved ${done} course${done === 1 ? "" : "s"}; ${failed} failed (see log). The rest is searchable now.`;
    }
    setTimeout(() => refreshKb(), 600);
  } catch (e) {
    setKbBuildError(e.message);
  }
}

function setKbBuildError(msg) {
  const statusEl = $("kbBuildStatus");
  if (statusEl) { statusEl.textContent = `❌ ${msg}`; statusEl.classList.add("error"); }
}

async function handleKbFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const statusEl = $("kbBuildStatus");
  const panel = $("kbBuildPanel");
  if (panel) panel.hidden = false;
  if (statusEl) statusEl.textContent = "Uploading archive.json to the shared DB…";
  try {
    const text = await file.text();
    let parsed; try { parsed = JSON.parse(text); } catch { setKbBuildError("That file isn't valid JSON."); return; }
    const r = await fetch("/api/kb-scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "bundle", bundle: parsed }),
    });
    if (!r.ok) { const err = await r.json().catch(() => ({})); setKbBuildError(err.error || r.status); return; }
    const data = await r.json();
    if (statusEl) statusEl.textContent = `✅ Saved ${data.meta?.noteCount?.toLocaleString()} notes to the shared knowledge base.`;
    setTimeout(() => refreshKb(), 600);
  } catch (err) { setKbBuildError(err.message); }
  finally { e.target.value = ""; }
}

// ---------------------------------------------------------------------------
// Public search (with course/year filter chips)
// ---------------------------------------------------------------------------
let kbActiveCourse = "";
let kbActiveYear = "";

async function runKbSearch(query) {
  const results = $("kbResults");
  if (!results) return;
  query = (query || "").trim();
  if (!query) {
    results.hidden = true;
    results.innerHTML = "";
    const count = $("kbResultCount");
    if (count) { count.hidden = true; count.innerHTML = ""; }
    const chips = $("kbFilterChips");
    if (chips) chips.hidden = true;
    // No query → reveal the "discover by course" browse panel + example searches.
    showBrowsePanel();
    return;
  }
  // A real query supersedes browse; hide the browse panel.
  hideBrowsePanel();
  try {
    const params = new URLSearchParams({ q: query, limit: "8" });
    if (kbActiveCourse) params.set("course", kbActiveCourse);
    if (kbActiveYear) params.set("year", kbActiveYear);
    const r = await fetch("/api/kb-search?" + params.toString());
    const d = await r.json();
    results.hidden = false;
    results.innerHTML = "";
    renderFilterChips(d.filters);
    renderResultCount(d, { course: kbActiveCourse, year: kbActiveYear });
    if (!d.results || d.results.length === 0) {
      // "Did you mean" — when a typo returned nothing but a confident
      // correction exists in the corpus, offer a one-click retry.
      if (d.didYouMean) {
        const dym = document.createElement("div");
        dym.className = "kb-didyoumean";
        const label = document.createElement("span");
        label.textContent = "Did you mean ";
        dym.appendChild(label);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kb-didyoumean-btn";
        btn.textContent = d.didYouMean;
        btn.addEventListener("click", () => {
          const input = $("kbSearchInput");
          if (input) input.value = d.didYouMean;
          runKbSearch(d.didYouMean);
        });
        dym.appendChild(btn);
        dym.appendChild(document.createTextNode(" ?"));
        results.appendChild(dym);
      }
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No matches in the knowledge base.";
      results.appendChild(empty);
      return;
    }
    for (const note of d.results) {
      const row = document.createElement("div");
      row.className = "assignment kb-result-card";
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.dataset.noteIndex = String(note.noteIndex ?? "");
      row.setAttribute("aria-label", `Open note: ${note.t || "(untitled)"}`);
      const body = document.createElement("div");
      body.className = "assignment-body";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = note.t || "(untitled)";
      body.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [note.course, note.y, note.topic].filter(Boolean).join(" · ");
      body.appendChild(meta);
      if (note._snippet) {
        const snip = document.createElement("div");
        snip.className = "summary archive-snippet";
        snip.innerHTML = highlightSnippet(note._snippet, query);
        body.appendChild(snip);
      }
      // Related-notes preview: compact cross-links under the card so a
      // student can hop between related notes without opening each one.
      const preview = document.createElement("div");
      preview.className = "kb-related-preview";
      preview.hidden = true;
      body.appendChild(preview);
      row.appendChild(body);
      const open = () => {
        if (row.dataset.noteIndex !== "" && row.dataset.noteIndex != null) openKbNote(Number(row.dataset.noteIndex));
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
      results.appendChild(row);
      // Fill the preview asynchronously (reuses the related-notes route).
      if (note.noteIndex != null) renderRelatedPreview(preview, note.noteIndex);
    }
  } catch (e) {
    results.hidden = false;
    results.innerHTML = `<div class="empty">Search failed: ${e.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// "Browse by course" — a no-query discovery entry point (ROADMAP: richer
// empty state with a "browse by course" entry point). When the search box is
// empty we show (a) a row of example searches and (b) a course grid; clicking
// a course fetches /api/kb-browse?course=<name> and lists that course's notes
// in the same card shape the search results use.
// ---------------------------------------------------------------------------
function exampleSearches() {
  return ["STAR method", "cover letter", "soft skills", "interview", "study guide"];
}

function renderExamples() {
  const wrap = $("kbExamples");
  if (!wrap) return;
  // Keep the static label, append one chip per example.
  wrap.querySelectorAll(".kb-example-chip").forEach((n) => n.remove());
  for (const ex of exampleSearches()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kb-chip kb-example-chip";
    b.textContent = ex;
    b.addEventListener("click", () => {
      const input = $("kbSearchInput");
      if (input) { input.value = ex; runKbSearch(ex); }
    });
    wrap.appendChild(b);
  }
  wrap.hidden = false;
}

function showBrowsePanel() {
  renderExamples();
  const panel = $("kbBrowse");
  if (panel) panel.hidden = false;
  // Fresh visit → show the course grid, hide the per-course notes list.
  const notesEl = $("kbBrowseNotes");
  if (notesEl) notesEl.hidden = true;
  loadBrowseCourses();
}

function hideBrowsePanel() {
  const panel = $("kbBrowse");
  if (panel) panel.hidden = true;
  const ex = $("kbExamples");
  if (ex) ex.hidden = true;
  const back = $("kbBrowseBack");
  if (back) back.hidden = true;
}

async function loadBrowseCourses() {
  const list = $("kbBrowseCourses");
  if (!list) return;
  list.hidden = false;
  list.innerHTML = `<div class="empty">Loading courses…</div>`;
  try {
    const r = await fetch("/api/kb-browse");
    if (!r.ok) { list.innerHTML = `<div class="empty">Couldn't load courses.</div>`; return; }
    const d = await r.json();
    const courses = Array.isArray(d.courses) ? d.courses : [];
    if (!courses.length) { list.innerHTML = `<div class="empty">No courses yet — the knowledge base is empty.</div>`; return; }
    list.innerHTML = "";
    for (const c of courses) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "kb-course-card";
      card.setAttribute("aria-label", `Browse ${c.course} (${c.count} notes)`);
      const title = document.createElement("span");
      title.className = "kb-course-name";
      title.textContent = c.course;
      const meta = document.createElement("span");
      meta.className = "kb-course-meta";
      const yr = Array.isArray(c.years) && c.years.length ? c.years.join(", ") : "—";
      meta.textContent = `${c.count} note${c.count === 1 ? "" : "s"} · ${yr}`;
      card.appendChild(title);
      card.appendChild(meta);
      card.addEventListener("click", () => openCourse(c.course));
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty">Couldn't load courses (${e.message}).</div>`;
  }
}

async function openCourse(course) {
  const list = $("kbBrowseCourses");
  const notesEl = $("kbBrowseNotes");
  const back = $("kbBrowseBack");
  if (list) list.hidden = true;
  if (notesEl) { notesEl.hidden = false; notesEl.innerHTML = `<div class="empty">Loading ${course}…</div>`; }
  if (back) back.hidden = false;
  try {
    const r = await fetch("/api/kb-browse?course=" + encodeURIComponent(course));
    if (!r.ok) { if (notesEl) notesEl.innerHTML = `<div class="empty">Couldn't load this course.</div>`; return; }
    const d = await r.json();
    const notes = Array.isArray(d.notes) ? d.notes : [];
    if (!notes.length) { if (notesEl) notesEl.innerHTML = `<div class="empty">No notes in ${course}.</div>`; return; }
    if (notesEl) {
      notesEl.innerHTML = "";
      for (const note of notes) {
        const row = document.createElement("div");
        row.className = "assignment kb-result-card";
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.dataset.noteIndex = String(note.noteIndex ?? "");
        row.setAttribute("aria-label", `Open note: ${note.t || "(untitled)"}`);
        const body = document.createElement("div");
        body.className = "assignment-body";
        const title = document.createElement("div");
        title.className = "title";
        title.textContent = note.t || "(untitled)";
        body.appendChild(title);
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = [note.course, note.y, note.topic].filter(Boolean).join(" · ");
        body.appendChild(meta);
        if (note._snippet) {
          const snip = document.createElement("div");
          snip.className = "summary archive-snippet";
          // Browse snippets have no query to highlight; show plain text.
          snip.textContent = note._snippet;
          body.appendChild(snip);
        }
        const open = () => { if (row.dataset.noteIndex !== "") openKbNote(Number(row.dataset.noteIndex)); };
        row.appendChild(body);
        row.addEventListener("click", open);
        row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
        notesEl.appendChild(row);
      }
    }
  } catch (e) {
    if (notesEl) notesEl.innerHTML = `<div class="empty">Couldn't load this course (${e.message}).</div>`;
  }
}

// Render a compact related-notes preview inside a search-result card.
// Reuses /api/kb-related so the cross-links match the detail-modal panel.
async function renderRelatedPreview(container, noteIndex) {
  if (!container) return;
  try {
    const r = await fetch(`/api/kb-related?id=${encodeURIComponent(noteIndex)}&limit=3`);
    if (!r.ok) return;
    const d = await r.json();
    const related = d.related || [];
    if (!related.length) return;
    container.hidden = false;
    const tag = document.createElement("span");
    tag.className = "kb-related-preview-label";
    tag.textContent = "Related:";
    container.appendChild(tag);
    for (const rel of related) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kb-chip kb-related-preview-chip";
      b.title = "Open related note";
      // Only show the title in the compact chip; meta on hover via title.
      b.textContent = rel.t || "(untitled)";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation(); // don't also open the parent card
        openKbNote(rel.noteIndex);
      });
      container.appendChild(b);
    }
  } catch {
    /* related preview is non-critical; ignore */
  }
}

function renderFilterChips(filters) {
  const chips = $("kbFilterChips");
  if (!chips) return;
  const courses = (filters && filters.courses) || [];
  const years = (filters && filters.years) || [];
  if (courses.length === 0 && years.length === 0) { chips.hidden = true; chips.innerHTML = ""; return; }
  chips.hidden = false;
  chips.innerHTML = "";

  const makeChip = (label, kind, value, active) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kb-chip" + (active ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      if (kind === "course") kbActiveCourse = active ? "" : value;
      else kbActiveYear = active ? "" : value;
      const input = $("kbSearchInput");
      runKbSearch(input ? input.value : "");
    });
    return b;
  };

  if (years.length) {
    const lbl = document.createElement("span");
    lbl.className = "kb-chip-group-label";
    lbl.textContent = "Year:";
    chips.appendChild(lbl);
    years.forEach((y) => chips.appendChild(makeChip(y, "year", y, kbActiveYear === y)));
  }
  if (courses.length) {
    const lbl = document.createElement("span");
    lbl.className = "kb-chip-group-label";
    lbl.textContent = "Course:";
    chips.appendChild(lbl);
    // Cap to keep the UI tidy; most KBs have a manageable number.
    courses.slice(0, 24).forEach((c) => chips.appendChild(makeChip(c, "course", c, kbActiveCourse === c)));
  }

  // ROADMAP #55: a "Clear filters" control appears only when a facet is active,
  // so the student can reset the course/year selection without retyping.
  if (kbActiveCourse || kbActiveYear) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "kb-chip kb-clear-filters";
    clear.textContent = "✕ Clear filters";
    clear.title = "Remove the active course/year filter";
    clear.addEventListener("click", () => {
      kbActiveCourse = "";
      kbActiveYear = "";
      const input = $("kbSearchInput");
      runKbSearch(input ? input.value : "");
    });
    chips.appendChild(clear);
  }
}

// ROADMAP #55: show "Showing N of M notes" above the results, narrowing M when
// a course/year filter is active, plus a "Clear filters" control that resets
// the active facet(s) and re-runs the search.
function renderResultCount(data, { course, year }) {
  const el = $("kbResultCount");
  if (!el) return;
  const hidden = !data || !Array.isArray(data.results) || data.results.length === 0;
  if (hidden) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const shown = data.results.length;
  const total = typeof data.filteredCount === "number" ? data.filteredCount : (data.meta?.noteCount ?? shown);
  el.textContent = buildResultSummary({ shown, total, course, year });
}

// ---------------------------------------------------------------------------
// AI Tutor (RAG over the shared DB)
// ---------------------------------------------------------------------------
let tutorMessages = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function addTutorMessage(role, text, isStreaming) {
  const wrap = $("kbTutorMessages");
  if (!wrap) return;
  let el = wrap.querySelector(`[data-role="${role}"]:last-child`);
  if (!el || !isStreaming) {
    el = document.createElement("div");
    el.className = `ai-msg ai-msg-${role}`;
    el.dataset.role = role;
    el.textContent = text;
    wrap.appendChild(el);
  } else {
    el.textContent = text;
  }
  wrap.scrollTop = wrap.scrollHeight;
  return el;
}

async function sendTutor(text) {
  const input = $("kbTutorInput");
  if (input) input.value = "";
  tutorMessages.push({ role: "user", content: text });
  addTutorMessage("user", text);
  const sourcesEl = $("kbTutorSources");
  if (sourcesEl) sourcesEl.innerHTML = `<span class="ai-context-note">Thinking… (searching the knowledge base)</span>`;

  const assistantEl = addTutorMessage("assistant", "…", true);
  let acc = "";
  try {
    const r = await fetch("/api/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: currentAccessToken() ? `Bearer ${currentAccessToken()}` : "" },
      body: JSON.stringify({ messages: tutorMessages }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      acc = `❌ ${err.error || err.message || r.status}`;
      if (assistantEl) assistantEl.textContent = acc;
      return;
    }
    const notesUsed = Number(r.headers.get("X-KB-Notes") || "0");
    // Feature: expose WHICH notes the tutor grounded on, as clickable chips
    // that jump to the full note (openKbNote). The server returns them as a
    // JSON line on a dedicated stream event so the UI can render them once.
    let sources = [];
    if (sourcesEl) {
      sourcesEl.innerHTML = notesUsed > 0
        ? `<span class="ai-context-note">📚 Grounded in ${notesUsed} note${notesUsed === 1 ? "" : "s"} from the knowledge base</span>`
        : `<span class="ai-context-note">⚠️ No matching notes found — answer may be limited</span>`;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      // SSE: lines like "data: {...}" — accumulate the content deltas.
      for (const line of chunk.split("\n")) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m) continue;
        const payload = m[1].trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          // A control event from the tutor route: sources used for grounding.
          if (j && j.type === "sources") { sources = Array.isArray(j.notes) ? j.notes : []; continue; }
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) { acc += delta; if (assistantEl) assistantEl.textContent = acc; }
        } catch {}
      }
    }
    // After streaming, render the source chips (clickable -> open the note).
    renderTutorSources(sourcesEl, sources);
    tutorMessages.push({ role: "assistant", content: acc });
  } catch (e) {
    if (assistantEl) assistantEl.textContent = `❌ ${e.message}`;
  }
}

function renderTutorSources(container, notes) {
  if (!container) return;
  const chips = tutorSourceList(notes);
  if (!chips.length) return; // nothing to attribute
  // Keep the "grounded in N notes" note, then append clickable chips.
  const wrap = document.createElement("div");
  wrap.className = "kb-source-chips";
  const lbl = document.createElement("span");
  lbl.className = "kb-source-chips-label";
  lbl.textContent = "Sources used:";
  wrap.appendChild(lbl);
  for (const c of chips) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kb-chip kb-source-chip";
    b.title = "Open this note";
    b.innerHTML = `<span class="kb-chip-title"></span><span class="kb-chip-sub"></span>`;
    b.querySelector(".kb-chip-title").textContent = c.title;
    if (c.subtitle) b.querySelector(".kb-chip-sub").textContent = c.subtitle;
    b.addEventListener("click", () => openKbNote(c.noteIndex));
    wrap.appendChild(b);
  }
  container.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Note-detail modal — open a full note by its bundle index (see /api/kb-note)
// ---------------------------------------------------------------------------
async function openKbNote(index) {
  const modal = $("kbNoteModal");
  const titleEl = $("kbNoteTitle");
  const metaEl = $("kbNoteMeta");
  const bodyEl = $("kbNoteBody");
  const linkEl = $("kbNoteObsidianLink");
  if (!modal || !bodyEl) return;
  bodyEl.innerHTML = `<div class="empty">Loading…</div>`;
  if (metaEl) metaEl.textContent = "";
  if (titleEl) titleEl.textContent = "Loading…";
  if (linkEl) linkEl.hidden = true;
  modal.hidden = false;
  try {
    const r = await fetch("/api/kb-note?id=" + encodeURIComponent(index));
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      bodyEl.innerHTML = `<div class="empty">Couldn't load this note (${err.error || r.status}).</div>`;
      if (titleEl) titleEl.textContent = "Note";
      return;
    }
    const note = await r.json();
    if (titleEl) titleEl.textContent = note.t || "(untitled)";
    if (metaEl) metaEl.textContent = [note.course, note.y, note.topic].filter(Boolean).join("  ·  ");
    // Prefer the full body, fall back to summary. renderLightMarkdown escapes
    // HTML and turns markdown links ([text](url)) into clickable <a> tags, so
    // teacher materials + student submission links are actually clickable.
    const fullText = (note.x || note.s || "").trim();
    if (fullText) {
      bodyEl.innerHTML = renderLightMarkdown(fullText);
    } else {
      bodyEl.innerHTML = `<div class="empty">This note has no body text.</div>`;
    }
    if (linkEl) {
      if (note.p) { linkEl.href = "obsidian://open?path=" + encodeURIComponent(note.p); linkEl.hidden = false; }
      else linkEl.hidden = true;
    }
    // Feature A: cross-link related notes.
    await renderRelatedNotes(index);
  } catch (e) {
    bodyEl.innerHTML = `<div class="empty">Failed to load note: ${e.message}</div>`;
  }
}

async function renderRelatedNotes(index) {
  const wrap = $("kbNoteRelated");
  const list = $("kbNoteRelatedList");
  if (!wrap || !list) return;
  wrap.hidden = true;
  list.innerHTML = "";
  try {
    const r = await fetch("/api/kb-related?id=" + encodeURIComponent(index) + "&limit=5");
    if (!r.ok) return;
    const d = await r.json();
    const related = d.related || [];
    if (!related.length) return;
    for (const rel of related) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "kb-related-item";
      const title = document.createElement("span");
      title.className = "kb-related-item-title";
      title.textContent = rel.t || "(untitled)";
      item.appendChild(title);
      const meta = document.createElement("span");
      meta.className = "kb-related-item-meta";
      meta.textContent = [rel.course, rel.y].filter(Boolean).join(" · ");
      item.appendChild(meta);
      item.addEventListener("click", () => openKbNote(rel.noteIndex));
      list.appendChild(item);
    }
    wrap.hidden = false;
  } catch (e) { /* related panel is non-critical; ignore */ }
}

function closeKbNote() {
  const modal = $("kbNoteModal");
  if (modal) modal.hidden = true;
}

// Allow Esc / backdrop click to close both KB modals.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const nm = $("kbNoteModal");
      const tm = $("kbTutorModal");
      if (nm && !nm.hidden) nm.hidden = true;
      if (tm && !tm.hidden) tm.hidden = true;
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("modal")) {
      e.target.hidden = true;
    }
  });
}

// ---------------------------------------------------------------------------
// token helpers (fallback; app.js owns the canonical token but we cache for scrape)
// ---------------------------------------------------------------------------
function loadKbToken() {
  try { const raw = localStorage.getItem(KB_TOKEN_KEY); if (!raw) return null; const p = JSON.parse(raw); if (Date.now() < p.expiresAt) return p.token; } catch {}
  return null;
}
function storeKbToken(token, expiresInSec) {
  try { localStorage.setItem(KB_TOKEN_KEY, JSON.stringify({ token, expiresAt: Date.now() + (expiresInSec - 30) * 1000 })); } catch {}
}

// Auto-wire once the DOM is ready, independent of Google Identity Services.
// (app.js also calls wireKbEvents() after GIS loads; the idempotent guard
//  prevents double-binding. This makes the KB usable even if GIS is blocked.)
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => wireKbEvents());
  } else {
    wireKbEvents();
  }
}
