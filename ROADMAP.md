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
- [ ] Detect NEW Classroom content on every load and offer/auto re-scrape. After
  sign-in, on each KB view call a lightweight bounded check (new `mode:"changed"` in
  kb-scrape.js, or `/api/kb-changes`) that compares stored `meta` (generatedAt /
  per-course note counts) against the live Classroom course list — one bounded call,
  stays under the Edge 10s limit. If new coursework/announcements exist, show a
  non-blocking "X new items — Update now" banner AND/OR fire the existing
  resumable list→course background scrape. Must run AFTER the KB shell paints so
  the view never blocks on it.
- [ ] Cut KB load time (still open after private/IndexedDB pivot). Measure first:
  (a) lazy-load non-critical panels (build/tutor/related preview); (b) debounce
  search; (c) code-split heavy modules; (d) `performance.now` marks around first
  paint + search. Acceptance: populated KB view paints <3s warm with local bundle.
- [x] Replace the Obsidian-only "open" action with a UNIVERSAL external-open. Most
  users don't have Obsidian, and for vault notes the `obsidian://open?path=...` link
  points at a local file they can't reach. Fixed 2026-07-15: note modal now resolves
  the best primary action — a real source URL -> "Open original" (new tab); else a
  vault/local path -> "Download note (.md)"; Obsidian is a secondary, clearly-labelled
  opt-in. Pure resolver `resolveNoteOpenAction()` in kb.js + 5 unit tests + browser e2e.
- [x] Visual styles / theme switching in Settings. Shipped 2026-07-19: Display → Theme (System / Light / Dark) persists locally and applies CSS variables live. Covered by `scripts/theme_test.mjs`.

## 🧠 Soon
- [x] KB: "Did you mean" typo-tolerance — suggest a corrected spelling when a search returns nothing (query-side fuzzy spelling).
- [ ] Tutor: conversation memory across messages within a session (already in place) + a "new topic" reset.
- [ ] KB: export the whole knowledge base as a printable PDF / markdown book (JSON/MD/CSV export already exists — extend to a readable multi-note "book" + optional print stylesheet; PDF optional).
- [x] Search: typo-tolerance using the existing fuzzy stem matching (extend to query side) — covered by didYouMean path (`544456d`, `b06c0a3`).
- [ ] Tutor: let students rate answers (👍/👎) and store feedback for tuning.

## 💡 Ideas / experiments
- [ ] Multi-language tutor (Slovak) using the existing prefLanguage plumbing.
- [ ] "Study streak" gamification on the KB home.
- [ ] Auto-generate a weekly "what to review" digest from the KB + planner.
- [ ] Voice tutor: pipe tutor answers through TTS (Edge/OpenAI) for hands-free study.
- [ ] Per-student progress tracking (which notes they've opened / quizzed on).

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
- [x] KB: Planner→KB bridge — a "🔍 KB" button on every assignment card that searches the knowledge base for that topic.
- [x] KB: richer empty state with example searches and a "browse by course" entry point.
- [x] KB: search result count + "showing N of M notes" and a "clear filters" control when course/year chips are active.
- [x] KB Settings dropdowns stylized with shared `.settings-select` (`0502235`) — do not re-do.
- [ ] Tutor: copy-to-clipboard on each answer + "save to my study list" (personal, localStorage).
- [ ] Tutor: surface which provider/model answered (already in X- headers) as a small line under the answer.
- [ ] KB: persist last-used sort/filters across visits via localStorage (settings defaults exist — wire live search state too).
- [ ] (loop: invent more here every run when higher lists are blocked or thin)

## 🚧 Blocked (pinged — needs Pepuldo)
When the loop hits a blocker it cannot climb (needs the Vercel URL, KV keys,
OAuth authorized-domain, or a product decision from Pepuldo), it moves the item
HERE, posts to #kb-site-status with --mention --pin --blocker, and KEEPS WORKING on other
features. The --blocker flag maintains an editable "OPEN BLOCKERS" log message
(the bot updates it in place) so it's findable even if the channel lacks pin
permission. Blocked items do not count toward the run's shipped-feature budget.
Format each entry: `- [ ] <feature>: blocked because <reason>. Needs from Pepuldo: <exact ask>.`

