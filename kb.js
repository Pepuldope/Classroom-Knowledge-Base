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

const $ = (id) => document.getElementById(id);
const KB_TOKEN_KEY = "cwa_kb_token";
export { highlightSnippet };

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
  if (hasDb) renderKbMeta(meta);
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
// Build / scrape into the shared DB
// ---------------------------------------------------------------------------
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
  if (statusEl) statusEl.textContent = "Scraping your Classroom into the shared DB…";
  if (logEl) logEl.innerHTML = "";
  if (progress) progress.style.width = "10%";

  try {
    const r = await fetch("/api/kb-scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ source: "classroom", authToken: token }),
    });
    if (progress) progress.style.width = "100%";
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setKbBuildError(err.error || r.status);
      return;
    }
    const data = await r.json();
    if (statusEl) statusEl.textContent = `✅ Saved ${data.meta?.noteCount?.toLocaleString()} notes to the shared knowledge base.`;
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
    const chips = $("kbFilterChips");
    if (chips) chips.hidden = true;
    return;
  }
  try {
    const params = new URLSearchParams({ q: query, limit: "8" });
    if (kbActiveCourse) params.set("course", kbActiveCourse);
    if (kbActiveYear) params.set("year", kbActiveYear);
    const r = await fetch("/api/kb-search?" + params.toString());
    const d = await r.json();
    results.hidden = false;
    results.innerHTML = "";
    renderFilterChips(d.filters);
    if (!d.results || d.results.length === 0) {
      results.innerHTML = `<div class="empty">No matches in the knowledge base.</div>`;
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
      row.appendChild(body);
      const open = () => {
        if (row.dataset.noteIndex !== "" && row.dataset.noteIndex != null) openKbNote(Number(row.dataset.noteIndex));
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
      results.appendChild(row);
    }
  } catch (e) {
    results.hidden = false;
    results.innerHTML = `<div class="empty">Search failed: ${e.message}</div>`;
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
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) { acc += delta; if (assistantEl) assistantEl.textContent = acc; }
        } catch {}
      }
    }
    tutorMessages.push({ role: "assistant", content: acc });
  } catch (e) {
    if (assistantEl) assistantEl.textContent = `❌ ${e.message}`;
  }
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
    // Prefer the full body, fall back to summary. Escape to avoid injection.
    const fullText = (note.x || note.s || "").trim();
    if (fullText) {
      bodyEl.textContent = fullText;
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
    console.log("[DBG-rel] status", r.status, "ok", r.ok);
    if (!r.ok) return;
    const d = await r.json();
    console.log("[DBG-rel] got related len", (d.related||[]).length);
    const related = d.related || [];
    if (!related.length) return;
    console.log("[DBG-rel] about to render", related.length, "items");
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
  } catch { /* related panel is non-critical; ignore */ }
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
