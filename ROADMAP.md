# Classroom Knowledge Base — Feature Backlog

Long-term goal (Pepuldo, 2026-07-11): the AI fleet continuously upgrades this
site so it's increasingly user-friendly and feature-rich for students.

**This file is owned by Pepuldo. The loop may not add to it.** (Changed
2026-08-07; it previously told the loop to invent its own items.)

The long-term-site-dev cron job reads this file, takes the FIRST unchecked item —
"Reported by Pepuldo" sections first, then top to bottom — implements exactly one
per run, and ticks it. It may not add, reorder, or re-prioritise items, in any
section, including "## 🤖 Agent-Proposed Backlog". If there is no unchecked item
anywhere in this file, the correct outcome is to report NO AVAILABLE WORK and end
the run — that is a successful run, not an empty one. New work comes from Pepuldo
editing this file. Keep items concrete and student-facing.

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
**Closed as of 2026-08-07 — the loop may no longer add here.** This section was
machine-owned: the loop appended its own feature ideas whenever the lists above
were drained. That is what produced the invented-polish runs, so it is now read
only, like every other section. The loop may tick an item it shipped; nothing
else. History below is kept for the record.
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
- [x] KB: add a keyboard focus-ring check for long-label result cards on narrow screens (2026-07-28): result cards now expose a deliberate accent 2px focus ring with offset, covered by `kb_result_card_focus_test.mjs`.
- [x] Continuity: verify mobile navigation remains horizontally scroll-safe after opening a long-label KB result. Shipped 2026-07-28: the shared mobile header now constrains the view switcher to an intentional horizontal scroll region, with a red/green Playwright regression gate.
- [x] KB: show a non-animated reduced-motion label/icon state in the related-preview error path, not only loading. Shipped 2026-07-28: failed related-note previews now retain a labeled, static `!` marker under reduced motion.
- [x] Perf: add a warm local related-preview timing assertion so regressions are caught before hosted latency checks. Shipped 2026-07-28: cached per-note related-token sets and a 400-note/40-preview warm budget gate keep the local path under 100ms on the test fixture.
- [x] KB: add a scoped retry action when related-note previews fail, preserving the parent result card state. Shipped 2026-07-28: keyboard retry recovers the preview without opening the parent card.
- [x] Continuity: verify reduced-motion related-preview errors remain readable in the Archive and Planner theme surfaces. Shipped 2026-07-29: shared error styling now uses theme foreground contrast and polite status semantics, with a 390px light/dark reduced-motion browser gate across both surfaces.
- [x] Perf: expose a local related-preview cache hit/miss diagnostic in development-only timing output without logging note content (2026-07-28).
- [x] Continuity: add a mobile related-preview retry focus-ring smoke across Archive and Planner theme surfaces. Shipped 2026-07-29: the reduced-motion 390px browser gate checks deliberate 2px focus rings, visibility, and overflow in both themes.
- [x] Continuity: add a browser smoke that verifies the local cache summary remains hidden outside the development harness and does not alter production KB layout (2026-07-29).
- [x] Perf: add a bounded local related-preview cache reset control to the development harness without exposing it in production. Shipped this run: the standalone harness can clear only the in-memory related-token cache and announces completion locally.
- [x] Perf: add a bounded local related-preview cache hit/miss summary to the development harness without showing note content. Shipped 2026-07-29: the localhost-only harness now refreshes a content-free hit/miss label and keeps the production surface unchanged.
- [x] KB: add a keyboard-accessible “retry related notes” action with focus restoration after a preview error. Shipped 2026-07-28: retry restores focus to the parent result card after the async preview recovers.
- [x] Continuity: verify related-preview error announcements remain distinct after repeated retry failures in the KB, Archive, and Planner surfaces. Shipped 2026-07-29: KB retry announcements now identify repeated failures ("still unavailable after N attempts") and the browser gate exercises two failures before recovery.
- [x] Accessibility: add a reduced-motion keyboard smoke for related-preview retry focus restoration on 390px screens. Shipped 2026-07-29: the focused browser gate drives a real failed retry with reduced motion and requires parent-card focus restoration.
- [x] Continuity: add a live browser smoke for repeated related-preview retry announcements in Archive and Planner assignment cards. Shipped 2026-07-30: `scripts/live_cross_view_related_retry_test.mjs` runs against the deployed shell and is wired into `scripts/test.sh`.
- [x] Continuity: add a production-safe browser timing summary for the local related-preview path without exposing diagnostics to students. Shipped 2026-07-30: bounded last/average/max timing is visible only in the localhost KB harness and never in the integrated student surface.
- [x] Perf: reduce hosted related-preview warm latency below the 1s product budget while preserving the local IndexedDB fast path. Shipped 2026-07-30: warm legacy related lookups reuse a bounded 15s in-process bundle cache and invalidate after writes; post-deploy warm samples were 553–704ms.
- [x] Perf: reduce hosted legacy search warm latency below the 1s product budget without logging note content. Shipped 2026-07-30: compatibility search now reuses a bounded response for the same bundle/query/filter key; ingestion replaces the bundle identity so stale responses cannot survive writes. Live probe remains populated (3,990 notes) and warm max was 983.54ms before deployment.
- [x] Perf: add p95 hosted legacy search latency reporting across three warm probes without logging note content (2026-07-30).
- [x] Privacy: build the Classroom-derived KB entirely in the browser and persist the curated bundle in the user's IndexedDB; tutor remains the only KB request sent to the server.
- [x] Search: guarantee every local result has a usable snippet, falling back to title/topic when source text is empty (2026-08-01).
- [x] Compatibility: extend legacy and local browse-by-course paths with kind/family filters and explicit relevance/recency/course/title sorting; covered by route + local model tests (2026-08-02).
- [x] Continuity: verify cached legacy related responses remain fresh after a live incremental ingestion write.
- [x] Privacy: audit legacy compatibility timing metadata for note-content leakage. Shipped 2026-08-03: search/related timing headers now use an allow-listed, numeric-only formatter covered by `tests/kb-route-privacy.test.js`.
- [x] Accessibility: add a browser assertion that related-preview loading and error status remain announced after a cache hit. Shipped 2026-07-31: related previews now expose explicit polite status announcements for local-cache loading, ready counts, and retryable errors; covered by `tests/kb-related-status.test.js`.
- [x] Privacy: add a browser assertion that tutor requests never include unselected bundle bodies. Shipped this run: local grounding selection is isolated in `kb-tutor-context.js` with a regression test and the canonical gate.
- [x] Auth: add a browser smoke for silent session rehydration followed by account switching. Shipped 2026-07-30: private KB routing now rejects signed-out access, preserves the account chooser/revoke escape hatches, and returns to Planner after sign-out or wrong-account recovery.
- [x] Continuity: add a deployed smoke that opens Settings after a local bundle clear and rebuild prompt. Shipped this run: `settings_clear_rebuild_test.mjs` now seeds a local bundle, clears it through the real Settings control, and verifies the rebuild card returns locally and on the deployed shell.
- [x] Accessibility: announce the KB empty/rebuild transition after a Settings clear with a dedicated polite status (2026-07-31).
- [x] Accessibility: restore focus to the KB build button after the empty/rebuild transition so keyboard users can continue without hunting.
- [x] Privacy: add a local-storage audit that confirms sign-out removes cached Classroom credentials but preserves no token values in page storage. Shipped 2026-07-31: access tokens now live in the shared IndexedDB store; legacy `cwa_token_v9` / `cwa_kb_token` values are migrated once and removed.
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
- [x] Privacy: clear the IndexedDB auth record when Classroom returns 400/403 and require the account chooser on the next interactive sign-in. Shipped 2026-07-31: both the report loader and browser-local KB builder now preserve the status and converge on the existing wrong-account reset/revoke flow.
- [x] Privacy: make the Settings account-storage explanation match persistent IndexedDB auth (short-lived token, cleared on sign-out; 2026-08-01).
- [x] Auth: add a browser smoke proving an IndexedDB session survives a full page reload without exposing token values in localStorage. Shipped 2026-08-01: `scripts/auth_session_reload_test.mjs` seeds the real IndexedDB auth module, reloads the app with stubbed Classroom/GIS boundaries, and checks the signed-in shell plus absence of token material in local/session storage.
- [x] Continuity: verify Archive, Planner, and Knowledge Base all converge on the same local auth-session record after sign-in and sign-out (2026-08-01).
- [x] Privacy: add a browser assertion that the tutor request payload stays bounded when a search returns many matching notes. Shipped this run: client-side grounding now strips source paths and caps each selected note before `/api/tutor` serialization; the many-match regression stays under 24,000 characters.
- [x] Privacy: remove the integrated KB UI's legacy server search/browse/note/related fallbacks; empty and populated interactions stay in the local IndexedDB bundle, with a browser request assertion (2026-08-02).
- [ ] Continuity: verify the KB rebuild card remains hidden during a resumed incremental Classroom build and returns only after a true empty state.
- [x] Accessibility: verify the in-progress KB build status remains announced after the onboarding card is hidden. Shipped 2026-08-02: build status now has a polite atomic live region and course-count progress announcements in both integrated and harness surfaces.
- [x] Privacy: verify interrupted local Classroom builds do not persist partial credentials or raw token values. Shipped 2026-08-02: abort checkpoints now stop after in-flight course requests and before local bundle synthesis; regression covered by `tests/archive-builder-abort.test.js`.
- [x] Accessibility: add a narrow-screen browser smoke for related-preview status announcements and retry focus restoration (2026-08-01): `kb_related_mobile_status_test.mjs` now checks the real loading/error status layout, long-message wrapping, retry visibility, and no horizontal overflow at 390px; the gate is wired into `scripts/test.sh`.
- [x] KB: expose the local browse year facet alongside course/type/class-type filters so students can narrow a course's notes without starting a text search (2026-08-03).
- [x] KB: persist the selected browse course/year filter locally and restore it when reopening Browse (2026-08-03).
- [x] Privacy: route-level regression coverage proving legacy compatibility timing and error responses never echo note titles, snippets, paths, or bodies (2026-08-03).
- [x] Continuity: persist and restore an interrupted local Classroom build checkpoint without exposing partial credentials or showing a stale rebuild card (2026-08-03).
- [x] UX: show a bounded course-by-course resume summary before restarting an interrupted local Classroom build (2026-08-03).
- [x] Continuity: verify the KB rebuild card remains hidden during a resumed incremental Classroom build and returns only after a true empty state. Shipped 2026-08-03: `scripts/kb_checkpoint_browser_test.mjs` exercises the real IndexedDB checkpoint, resume surface, and true-empty transition.
- [x] Privacy: add a browser assertion that resumed checkpoint records contain no authorization headers or token-shaped values. Shipped 2026-08-03: the browser test verifies the storage seam strips token-shaped fields and values before IndexedDB persistence.
- [x] KB: add a local “recently studied” filter for notes opened in the last 7 days. Shipped this run: Browse now filters the private local bundle using existing note-open progress.
- [x] Tutor: add a local per-thread rename control without uploading thread metadata (2026-08-04).
- [x] Continuity: add a browser smoke for mobile Settings navigation after clearing and rebuilding a local KB (2026-08-04): `settings_mobile_rebuild_test.mjs` covers the real menu → Settings → clear → reopen path at 390px.
- [x] KB: show a clear empty-state recovery action when the recently studied filter has no matches (2026-08-04).
- [x] Tutor: add a local per-thread archive/delete control without uploading thread metadata.
- [x] Tutor: add a local restore action for archived threads without uploading thread metadata (2026-08-04).
- [x] Continuity: add a mobile smoke for switching from the KB rebuild prompt back to Planner without stale modal state (2026-08-05).
- [x] Privacy: add a browser assertion that local Settings export/clear actions never issue a network request containing bundle content (2026-08-04).
- [x] Privacy: add a browser assertion that local KB download filenames and MIME types remain explicit and content-safe. Shipped this run: `noteDownloadSpec` and `exportDownloadSpec` now centralize the contract with model coverage.
- [x] Continuity: add an authenticated mobile smoke proving the KB tutor modal also closes when switching to Planner (2026-08-05).
- [x] Accessibility: restore focus to the Planner navigation control after closing a KB modal during a view switch (2026-08-05).
- [x] Performance: measure and keep the KB rebuild-to-Planner transition under 100ms on warm local state (2026-08-05): the authenticated mobile smoke now records three in-page warm samples and enforces a nearest-rank p95 budget; observed p95 was 7.00ms locally.
- [x] Accessibility: restore focus to the originating KB result after closing a note-detail modal (2026-08-05).
- [x] Continuity: verify Archive and Planner navigation focus remains visible after a KB modal transition (2026-08-06).
- [x] KB: announce note-modal open and close state changes to screen readers without exposing note bodies.
- [x] KB: add a local “pin note” action that persists only note identifiers and titles (2026-08-05).
- [x] Continuity: add a warm local cross-view smoke for returning from note detail to the same KB result (2026-08-05): `scripts/kb_note_roundtrip_test.mjs` seeds IndexedDB, measures three warm close/focus cycles, and rejects legacy note-route fallback.
- [x] Accessibility: expose route-transition focus restoration in a persistent, theme-safe status hint for keyboard users (2026-08-06).
- [x] Continuity: add a narrow-screen Archive modal transition check for focus visibility and no horizontal overflow. Shipped this run: `scripts/archive_modal_mobile_test.mjs` covers the real 390px Archive note modal, close-control focus, and overflow budget.
- [x] Accessibility: restore focus to the originating Archive note row after closing its modal without exposing note content (2026-08-06): Archive browse rows are keyboard-operable and modal close returns focus only to a still-connected origin.
- [x] Privacy: add a browser assertion that route-transition focus markers never serialize into local storage or tutor payloads. Shipped 2026-08-06: the allow-listed UI-only marker model returns null storage/tutor channels and rejects unknown text; wired into the canonical gate.
- [x] Accessibility: verify the persistent route-transition hint remains readable in both themes at narrow widths. Shipped 2026-08-06: `route_transition_hint_mobile_test.mjs` covers 390px light/dark contrast, wrapping, bounded width, and long-word safety.
- [x] Accessibility: add a keyboard smoke proving Archive note rows activate with Space as well as Enter and preserve focus after modal close.


## 🚧 Blocked (pinged — needs Pepuldo)
When the loop hits a blocker it cannot climb (needs the Vercel URL, KV keys,
OAuth authorized-domain, or a product decision from Pepuldo), it moves the item
HERE, posts to #kb-site-status with --mention --pin --blocker, and KEEPS WORKING on other
features. The --blocker flag maintains an editable "OPEN BLOCKERS" log message
(the bot updates it in place) so it's findable even if the channel lacks pin
permission. Blocked items do not count toward the run's shipped-feature budget.
Format each entry: `- [ ] <feature>: blocked because <reason>. Needs from Pepuldo: <exact ask>.`

