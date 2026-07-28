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

## 🐛 Reported by Pepuldo (2026-07-25) — fix before new features
Fresh user reports from live use. **Prefer these over Agent-Proposed polish.**
- [x] Theme contrast gate: fixed unreadable dark-theme onboarding/tutor surfaces and added `scripts/theme_contrast_test.mjs` to enforce 4.5:1 text contrast in explicit light and dark themes (2026-07-25).
- [x] Visual common-sense gate: extend the contrast browser gate to cover interactive states, overflow/clipping, overlaps, and KB/Archive/Planner/Settings surfaces. **Root cause:** existing checks are geometry + light-theme screenshots only (`theme_test.mjs` = string normalize; settings styling = one select not transparent; kb_ui “visual gate” = radius/cursor/centering, explicitly no screenshot analysis; LOOP-GUARDRAILS only bans blank/error shots). Live repro: dark `.step-text` ≈ **1.05:1** contrast on near-white card. **Shipped 2026-07-25:** `scripts/visual_common_sense_test.mjs` now runs computed light/dark contrast, real hover/pressed/focus/disabled states, overflow/clipping/zero-size/overlap hygiene, and KB + Archive + Planner + Settings + onboarding/loading + modal samples; it is wired into `scripts/test.sh` after the local server starts.
- [x] KB build card: when a local knowledge-base bundle already exists / is already loading course content into the KB, hide the entire "Generate database" / "Build my knowledge base" / scrape-onboarding card **instantly** — do not wait for full note content to finish loading. If IndexedDB (or equivalent) already has a non-empty bundle or an in-progress load of an existing bundle, show only the search/study surface + loading UI. Reveal the build/generate card only in a true empty state (no bundle yet). Shipped 2026-07-25: loading surface now hides onboarding before IndexedDB/legacy discovery completes, with `kb_loading_test.mjs` coverage.

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
- [x] Tutor: unify Planner assignment-help tutor with the KB tutor pipeline (shared streaming, provider rotation, multi-turn, privacy-bounded context) without breaking Planner cards. Shipped 2026-07-23 in `da5a7e7`: Planner now sends bounded assignment/archive notes and its existing history through `/api/tutor`.
- [x] Settings: wire default search scope (all / current course / pinned courses) into live local KB search behavior, not only the control UI. Shipped 2026-07-23: local scope filtering now honors persisted pinned-course selections from the Settings editor.
- [x] KB: add a compact keyboard shortcut hint beside copy actions on wide screens (2026-07-26).
- [x] KB: add a compact copy-action status layout check to the dark-theme visual gate. Shipped 2026-07-26: the standing light/dark gate now verifies wrapping, shrink-safe flex sizing, visibility, and contrast for inline copy confirmation; tightened light success green to WCAG AA.
- [x] Perf: add a cache-warm probe to the hosted legacy search latency test. Shipped 2026-07-26: `scripts/kb_latency_test.mjs` records cold vs two warm requests, corpus/result counts, and reports the measured warm-budget breach without logging note content.
- [x] Continuity: add a mobile browser assertion that inline copy confirmation remains readable beside the action button (2026-07-26).
- [x] KB: exercise a long copied-status message at narrow mobile width without clipping or horizontal overflow. Shipped 2026-07-27: the mobile gate now reveals the real KB result surface and uses a deliberately long clipboard-failure message, so it catches zero-size and wrapping regressions instead of passing a hidden fixture.
- [x] Perf: expose a bounded local-vs-hosted latency comparison in the status report (2026-07-26): `KB_LOCAL_URL` adds local warm metrics, delta, and hosted/local ratio to the privacy-safe latency JSON report.
- [x] Continuity: verify copy confirmation remains announced after a second keyboard-triggered copy (2026-07-27).
- [x] KB: add a keyboard-only retry path for failed clipboard permissions with an assertive status check. Shipped 2026-07-27: failed copy now reveals and focuses a local Retry copy button, with keyboard Enter coverage in `kb_ui_test.mjs`.
- [x] KB: assert the copy-status fixture remains readable when both copy actions and history metadata are visible together. Shipped 2026-07-27: history metadata now shrink-wraps safely and wraps long labels on mobile.
- [x] KB: add a visible inline confirmation for copied search context with the result count (2026-07-25).
- [x] KB: add a narrow-screen result-card fixture with long course and topic labels. Shipped 2026-07-27: result-card mobile gate now exercises long unbroken title/course/topic labels and enforces no page/card overflow.
- [x] KB: verify copy-history dismissal remains keyboard reachable after a long metadata message wraps. Shipped 2026-07-27: narrow mobile gate now focuses the real dismissal control and requires the app's visible 2px focus ring.
- [x] KB: announce successful clipboard retry separately from the initial copy failure. Shipped 2026-07-27: retry success now gets its own assertive “Copied N notes after retry.” announcement and hides the retry control.
- [x] KB: keep long result snippets readable when related-note previews load asynchronously. Shipped 2026-07-27: result summaries now wrap safely with async related-preview content, covered by the 390px mobile overflow gate.
- [x] KB: keep the related-preview loading state height-stable while local notes resolve asynchronously. Shipped 2026-07-28: previews reserve a stable loading row and clear it on ready/empty/error.
- [x] KB: add a reduced-motion-friendly related-preview loading treatment for students who disable animation (2026-07-28): related previews now show a compact spinner normally and a static indicator under `prefers-reduced-motion: reduce`, covered by `kb_reduced_motion_test.mjs`.
- [ ] KB: add a keyboard focus-ring check for long-label result cards on narrow screens.
- [ ] Continuity: verify mobile navigation remains horizontally scroll-safe after opening a long-label KB result.
- [x] Planner tutor: show a visible “grounded in this assignment” context badge and source summary before sending a question. Shipped 2026-07-24 with a bounded local context model and pre-send assignment/material summary.
- [x] Planner tutor: keep the grounding badge readable on narrow mobile layouts and add a focused browser assertion (2026-07-24).
- [x] KB: keyboard-first result navigation (j/k or arrows through cards, Enter opens note, Esc closes) with visible focus rings (2026-07-23).
- [x] Continuity: automated smoke that opens Archive + Planner + Settings after KB changes and fails the run if any view errors (extend existing browser gates). Shipped 2026-07-23: `scripts/continuity_smoke_test.mjs` now exercises the shared navigation and Settings modal, and runs in `scripts/test.sh`.
- [x] Planner tutor: add a compact copy-to-clipboard action for the assignment grounding sources on mobile. Shipped 2026-07-24: grounded assignment badge now copies a compact title/course/source summary locally.
- [x] Tutor: add a local “study mode” button that turns the last grounded answer into three short quiz questions without uploading extra notes. Shipped 2026-07-24: generates three prompts locally from the rendered answer and keeps note privacy unchanged.
- [x] Planner tutor: preserve copied grounding source status for keyboard and screen-reader users with an assertive confirmation. Shipped 2026-07-24: copy success/failure now updates an assertive status region.
- [x] KB: add a local “copy search context” action that copies only the currently selected note titles and snippets (2026-07-24).
- [x] KB: let students mark individual study-mode prompts as completed locally and show a small progress indicator (2026-07-24).
- [x] KB: add a keyboard shortcut to open study mode for the latest tutor answer (Ctrl/Cmd+Shift+S; 2026-07-25).
- [x] KB: announce active filter and sort changes in a polite result-status region for keyboard users (2026-07-24).
- [x] KB: let students choose whether copied search context uses compact or line-separated formatting locally (2026-07-25).
- [x] KB: show a local “copied from N results” history entry without storing note bodies. Shipped 2026-07-26: persisted history now stores only count/query/timestamp metadata; copy-again text stays in memory for the current page.
- [x] KB: let students dismiss a stale copy-history entry locally without touching their bundle (2026-07-26).
- [x] Perf: add a bounded server timing header to legacy KB search/related responses for cold-latency diagnosis without logging note content (2026-07-25; exposed as `Server-Timing` plus Vercel-survivable `X-Server-Timing`).
- [x] KB: add a compact “copy again” action for the latest local search-context event without persisting note bodies (2026-07-25).
## 🚧 Blocked (pinged — needs Pepuldo)
When the loop hits a blocker it cannot climb (needs the Vercel URL, KV keys,
OAuth authorized-domain, or a product decision from Pepuldo), it moves the item
HERE, posts to #kb-site-status with --mention --pin --blocker, and KEEPS WORKING on other
features. The --blocker flag maintains an editable "OPEN BLOCKERS" log message
(the bot updates it in place) so it's findable even if the channel lacks pin
permission. Blocked items do not count toward the run's shipped-feature budget.
Format each entry: `- [ ] <feature>: blocked because <reason>. Needs from Pepuldo: <exact ask>.`

