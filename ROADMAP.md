# Classroom Knowledge Base — Feature Backlog

Long-term goal (Pepuldo, 2026-07-11): the AI fleet continuously upgrades this
site so it's increasingly user-friendly and feature-rich for students.

This file is the living backlog. The long-term-site-dev cron job reads it,
picks an item, implements it, marks it done, and APPENDS NEW IDEAS OF ITS OWN.
The loop is fully autonomous: when the static lists below are empty, it INVENTS
the next valuable feature and writes it under "## 🤖 Agent-Proposed Backlog",
then builds it. Keep items concrete and student-facing where possible.

## 🔥 Ready (high priority)
- [x] KB: subject/course filter chips above the search results.
- [x] KB: highlight matched query terms in each result snippet.
- [x] KB: add "related notes" panel on each search result (cross-link by topic/course).
- [x] Tutor: show clickable source chips under each answer that jump to the note.
- [x] Tutor: "explain like I'm 12" and "give me a practice problem" quick actions.
- [x] Planner→KB bridge: on each assignment, a "Search the knowledge base for this topic" button.

## 🐛 Reported by Pepuldo (2026-07-13) — fix before new features
These came straight from user feedback. Prefer these over speculative polish.
- [x] KB load: show a LOADING ANIMATION (spinner/skeleton) immediately on
  `showKbView()` / search. Done 2026-07-13 in `772bca3` + `91a6ede` (`.kb-spinner`,
  `.kb-loading-inline`, "Loading your knowledge base…"). Keep regressions covered
  by `scripts/kb_loading_test.mjs`.
- [x] Detect NEW Classroom courses on every load and offer a background update. Shipped 2026-07-20: after the local KB shell paints, a bounded `mode:"list"` check shows a non-blocking “N new courses — Update now” banner; coursework-count detection remains a follow-up once Classroom exposes per-course change metadata.
- [x] Cut KB load time (still open after private/IndexedDB pivot). Measure first:
  (a) lazy-load non-critical panels (build/tutor/related preview); (b) debounce
  search; (c) code-split heavy modules; (d) `performance.now` marks around first
  paint + search. Acceptance: populated KB view paints <3s warm with local bundle. Shipped 2026-07-20: cached local bundles skip the legacy server metadata probe.
- [x] Replace the Obsidian-only "open" action with a UNIVERSAL external-open. Most
  users don't have Obsidian, and for vault notes the `obsidian://open?path=...` link
  points at a local file they can't reach. Fixed 2026-07-15: note modal now resolves
  the best primary action — a real source URL -> "Open original" (new tab); else a
  vault/local path -> "Download note (.md)"; Obsidian is a secondary, clearly-labelled
  opt-in. Pure resolver `resolveNoteOpenAction()` in kb.js + 5 unit tests + browser e2e.
- [x] Visual styles / theme switching in Settings. Shipped 2026-07-19: Display → Theme (System / Light / Dark) persists locally and applies CSS variables live. Covered by `scripts/theme_test.mjs`.

## 🧠 Soon
- [x] KB: "Did you mean" typo-tolerance — suggest a corrected spelling when a search returns nothing (query-side fuzzy spelling).
- [x] Tutor: conversation memory across messages, a "new topic" reset, and a "clear chat" action (clear-chat shipped 2026-07-20).
- [x] KB: export the whole knowledge base as a printable PDF / markdown book (JSON/MD/CSV export already exists — extend to a readable multi-note "book" + optional print stylesheet; PDF optional). Shipped 2026-07-20: Settings now downloads a local grouped Markdown study book.
- [x] Search: typo-tolerance using the existing fuzzy stem matching (extend to query side) — covered by didYouMean path (`544456d`, `b06c0a3`).
- [x] Tutor: let students rate answers (👍/👎) and store feedback for tuning. Local-only ratings shipped 2026-07-20.

## 💡 Ideas / experiments
- [x] Multi-language tutor (Slovak) using the existing prefLanguage plumbing. Shipped 2026-07-21: Display → Language now persists locally and sends a bounded Slovak instruction with grounded tutor requests.
- [x] "Study streak" gamification on the KB home. Shipped 2026-07-21; local calendar-date validation hardened 2026-07-21.
- [x] Auto-generate a weekly "what to review" digest from the KB + planner. Shipped 2026-07-22: local weekly review card prioritizes unopened notes and falls back to recent notes.
- [x] Voice tutor: read tutor answers aloud with the browser's built-in speech engine for hands-free study (2026-07-22).
- [x] Per-student progress tracking (which notes they've opened / quizzed on). Shipped 2026-07-21: note opens are tracked locally and summarized in the KB view.

## ✅ Done
- [x] Build a private, per-user knowledge base from Classroom (IndexedDB client bundle).
- [x] Local full-text search over the private bundle (kb-client-search.js).
- [x] RAG AI tutor grounded only in the knowledge base (tutor.js).
- [x] Knowledge Base view + AI Tutor modal in the UI (kb.js), 3-tab nav.
- [x] Verified legacy ingestion and retrieval on the real school-backup vault (2,763 notes).
- [x] KB course/year filter chips (faceted search).

## 🤖 Agent-Proposed Backlog
The autonomous loop writes its own feature ideas here when the lists above are
drained, then implements them. This section is machine-owned — the loop adds,
ticks off, and re-prioritises freely. Seed ideas (the loop may reorder/extend):
- [x] Tutor: "summarise this note" quick action on each search result card.
- [x] KB: sort results by relevance / recency / course (sort toggle chips).
- [x] KB: keyboard shortcut (press "/" to focus search, Esc to clear).
- [x] Search: "did you mean" suggestion when a query returns <3 results.
- [x] KB: related-notes preview chips directly under each search result card (no need to open the note first).
- [x] KB: local weekly review card prioritizing unopened notes, with recent-note fallback when the bundle is fully explored (2026-07-22).
- [x] KB: parallelize legacy KV shard reads so related/search compatibility routes do not wait on shards serially (2026-07-20).
- [x] KB: Planner→KB bridge — a "🔍 KB" button on every assignment card that searches the knowledge base for that topic.
- [x] KB: richer empty state with example searches and a "browse by course" entry point.
- [x] KB: search result count + "showing N of M notes" and a "clear filters" control when course/year chips are active.
- [x] KB Settings dropdowns stylized with shared `.settings-select` (`0502235`) — do not re-do.
- [x] Tutor: save answers to my study list (personal, localStorage). Copy-to-clipboard + "New topic" reset shipped this run. Saved-answer action shipped 2026-07-20 with local deduplication and browser-only persistence.
- [x] Tutor: surface which provider/model answered (already in X- headers) as a small line under the answer. Shipped 2026-07-20 with local formatting coverage and the existing streamed response headers.
- [x] KB: persist last-used sort/filters across visits via localStorage (settings defaults exist — wire live search state too). Shipped this run: `cwa_kb_search_state` normalizes and restores course/year/type/class-type filters and sort order.
- [x] Settings: explain local storage, tutor context sharing, and read-only Classroom access in plain language (shipped 2026-07-21).
- [x] Tutor: retry a failed answer without duplicating the user's last prompt; keep grounding and conversation state intact.
- [x] KB: make the Settings "Related notes" control live in search previews and note detail panels (2026-07-21).
- [x] KB: show a local-only study streak on the home surface, updated when a student searches or opens the KB (2026-07-21).
- [x] KB: track locally which notes a student has opened and show an explored-note progress summary (2026-07-21).
- [x] KB: make in-view JSON/Markdown/CSV exports read only the local IndexedDB bundle (2026-07-21).
- [x] KB: show an honest empty local-progress state when no private bundle is cached (shipped 2026-07-22).
- [x] KB: show the signed-in Classroom account and safe switch/sign-out actions inside Knowledge Base Settings (2026-07-22).
- [x] KB: honor the Knowledge Base Settings default sort on a first visit, while preserving explicit saved filter/sort choices.
- [x] Tutor: add a local playback-speed preference for read-aloud answers (0.5×–2× slider in Knowledge Base Settings; 2026-07-22).
- [x] KB Settings: make the existing Comfortable / Compact reading-density control change KB result spacing locally (2026-07-22).
- [x] Settings: keep Knowledge Base range controls and local export/clear actions live across repeated visits (2026-07-22).
- [x] Settings: opt-in auto-build starts a private Classroom KB after sign-in only when no local bundle exists (2026-07-23).
- [x] KB: use relevance sorting for active searches while retaining newest-first on the browse surface (2026-07-23).
- [x] Settings: improve Settings tab accessibility (tablist/tab/tabpanel + aria-selected sync; 2026-07-23).
- [ ] Tutor: unify Planner assignment-help tutor with the KB tutor pipeline (shared streaming, provider rotation, multi-turn, privacy-bounded context) without breaking Planner cards.
- [x] Settings: wire default search scope (all / current course / pinned courses) into live local KB search behavior, not only the control UI. Shipped 2026-07-23: local scope filtering now honors persisted pinned-course selections from the Settings editor.
- [ ] Perf: cut hosted legacy `/api/kb-search` cold latency toward <1s while keeping the private IndexedDB path instant (measure before/after; do not break local fast path).
- [x] KB: keyboard-first result navigation (j/k or arrows through cards, Enter opens note, Esc closes) with visible focus rings (2026-07-23).
- [x] Continuity: automated smoke that opens Archive + Planner + Settings after KB changes and fails the run if any view errors (extend existing browser gates). Shipped 2026-07-23: `scripts/continuity_smoke_test.mjs` now exercises the shared navigation and Settings modal, and runs in `scripts/test.sh`.
- [ ] Tutor: optional local “study mode” that turns the last grounded answer into 3 short quiz questions without uploading extra notes beyond the answer context.

## 🚧 Blocked (pinged — needs Pepuldo)
When the loop hits a blocker it cannot climb (needs the Vercel URL, KV keys,
OAuth authorized-domain, or a product decision from Pepuldo), it moves the item
HERE, posts to #kb-site-status with --mention --pin --blocker, and KEEPS WORKING on other
features. The --blocker flag maintains an editable "OPEN BLOCKERS" log message
(the bot updates it in place) so it's findable even if the channel lacks pin
permission. Blocked items do not count toward the run's shipped-feature budget.
Format each entry: `- [ ] <feature>: blocked because <reason>. Needs from Pepuldo: <exact ask>.`

