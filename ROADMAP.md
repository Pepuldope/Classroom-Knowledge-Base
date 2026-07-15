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
These came straight from user feedback. The "DB empty → scrape onboarding" branch
ALREADY EXISTS (`refreshKb()` gates on `meta.noteCount` in kb.js:137-141), so the
new work is the loading state + new-content detection + the obsidian replacement.
- [ ] KB load: show a LOADING ANIMATION (spinner/skeleton) immediately on
  `showKbView()` while the DB is read, THEN show content if `noteCount > 0` OR the
  existing scrape onboarding if empty. Today the populated path renders `kbMain`
  blank during the meta fetch — on a fresh deploy (Vercel + Upstash KV cold start)
  that blank window reads as "~30s of nothing". Spinner must appear synchronously
  (before any await) and be removed the instant meta + first content paint.
- [ ] Detect NEW Classroom content on every load and offer/auto re-scrape. After
  sign-in, on each KB view call a lightweight bounded check (new `mode:"changed"` in
  kb-scrape.js, or `/api/kb-changes`) that compares stored `meta` (generatedAt /
  per-course note counts) against the live Classroom course list — one bounded call,
  stays under the Edge 10s limit. If new coursework/announcements exist, show a
  non-blocking "X new items — Update now" banner AND/OR fire the existing
  resumable list→course background scrape. Must run AFTER the KB shell paints so
  the view never blocks on it.
- [ ] Cut KB load time. Likely root cause: Vercel fn cold-start + Upstash KV
  cold-start on every redeploy (session is dropped → cold path each time).
  Implement + MEASURE: (a) add `Cache-Control: s-maxage` to the tiny meta call so
  repeat loads are served from the CDN edge; (b) lazy-render the browse panel after
  the shell; (c) add a meta-only endpoint that does NOT reassemble all shards;
  (d) add real timing marks (performance.now) around load so improvement is proven
  not guessed. Acceptance: populated KB view paints <3s warm, <8s cold.
- [x] Replace the Obsidian-only "open" action with a UNIVERSAL external-open. Most
  users don't have Obsidian, and for vault notes the `obsidian://open?path=...` link
  points at a local file they can't reach. Fixed 2026-07-15: note modal now resolves
  the best primary action — a real source URL -> "Open original" (new tab); else a
  vault/local path -> "Download note (.md)"; Obsidian is a secondary, clearly-labelled
  opt-in. Pure resolver `resolveNoteOpenAction()` in kb.js + 5 unit tests + browser e2e.
- [ ] Visual styles / theme switching in Settings. A Settings modal + "Display"
  tab ALREADY EXISTS (index.html:264-296) and styles.css is built on CSS
  variables (`:root { --bg, --fg, --card, --border, --muted, --accent... }`), so
  theming is plumbing, not a rewrite. Add a theme selector (Light / Dark / System)
  to the Display pane: (a) define a `[data-theme="dark"]` (and maybe "sepia"/
  "high-contrast") block that overrides the existing CSS vars; (b) apply it by
  setting `document.documentElement.dataset.theme` on load from localStorage
  (default System = follow `prefers-color-scheme`); (c) persist the choice;
  (d) flip it live from the settings UI without reload. Avoid hard-coded colors in
  components that would ignore the vars. Acceptance: Dark mode renders every
  surface (header, KB, tutor, modals) readable, toggle persists across reloads.

## 🧠 Soon
- [x] KB: "Did you mean" typo-tolerance — suggest a corrected spelling when a search returns nothing (query-side fuzzy spelling).
- [ ] Tutor: conversation memory across messages within a session (already in place) + a "new topic" reset.
- [ ] KB: export the whole knowledge base as a printable PDF / markdown book.
- [ ] Search: typo-tolerance using the existing fuzzy stem matching (extend to query side).
- [ ] Tutor: let students rate answers (👍/👎) and store feedback for tuning.

## 💡 Ideas / experiments
- [ ] Multi-language tutor (Slovak) using the existing prefLanguage plumbing.
- [ ] "Study streak" gamification on the KB home.
- [ ] Auto-generate a weekly "what to review" digest from the KB + planner.
- [ ] Voice tutor: pipe tutor answers through TTS (Edge/OpenAI) for hands-free study.
- [ ] Per-student progress tracking (which notes they've opened / quizzed on).

## ✅ Done
- [x] Scrape Classroom into a shared server-side safekeep DB (kv-store.js).
- [x] Public full-text search over the safekeep (kb-retrieval.js / kb-search.js).
- [x] RAG AI tutor grounded only in the knowledge base (tutor.js).
- [x] Knowledge Base view + AI Tutor modal in the UI (kb.js), 3-tab nav.
- [x] Verified retrieval on the real school-backup vault (2,763 notes).
- [x] KB course/year filter chips (faceted search).

## 🤖 Agent-Proposed Backlog
The autonomous loop writes its own feature ideas here when the lists above are
drained, then implements them. This section is machine-owned — the loop adds,
ticks off, and re-prioritises freely. Seed ideas (the loop may reorder/extend):
- [x] Tutor: "summarise this note" quick action on each search result card.
- [x] KB: sort results by relevance / recency / course (sort toggle chips).
- [x] KB: keyboard shortcut (press "/" to focus search, Esc to clear).
- [ ] Tutor: copy-to-clipboard button on each answer + "save note" to a personal study list.
- [ ] Tutor: show which provider/model answered (already in response headers — surface it in the UI).
- [x] Search: "did you mean" suggestion when a query returns <3 results.
- [x] KB: related-notes preview chips directly under each search result card (no need to open the note first).
- [x] KB: Planner→KB bridge — a "🔍 KB" button on every assignment card that searches the knowledge base for that topic.
- [x] KB: richer empty state with example searches and a "browse by course" entry point.
- [x] KB: search result count + "showing N of M notes" and a "clear filters" control when course/year chips are active.
- [ ] KB: persist last-used sort (relevance/recency/course) across searches via localStorage.
- [ ] Tutor: "copy answer" button on each tutor message + "save to my study list" (personal, localStorage).
- [ ] Tutor: surface which provider/model answered (already in X- headers) as a small line under the answer.

## 🚧 Blocked (pinged — needs Pepuldo)
When the loop hits a blocker it cannot climb (needs the Vercel URL, KV keys,
OAuth authorized-domain, or a product decision from Pepuldo), it moves the item
HERE, posts to #kb-site-status with --mention --pin --blocker, and KEEPS WORKING on other
features. The --blocker flag maintains an editable "OPEN BLOCKERS" log message
(the bot updates it in place) so it's findable even if the channel lacks pin
permission. Blocked items do not count toward the run's shipped-feature budget.
Format each entry: `- [ ] <feature>: blocked because <reason>. Needs from Pepuldo: <exact ask>.`

