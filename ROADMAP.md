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
- [ ] KB: add "related notes" panel on each search result (cross-link by topic/course).
- [ ] Tutor: show clickable source chips under each answer that jump to the note.
- [ ] Tutor: "explain like I'm 12" and "give me a practice problem" quick actions.
- [ ] Planner→KB bridge: on each assignment, a "Search the knowledge base for this topic" button.

## 🧠 Soon
- [ ] KB: highlight the matched query terms in each result snippet.
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
- [ ] Tutor: "summarise this note" quick action on each search result card.
- [ ] KB: sort results by relevance / recency / course (sort toggle chips).
- [ ] Tutor: copy-to-clipboard button on each answer + "save note" to a personal study list.
- [ ] KB: keyboard shortcut (press "/" to focus search, Esc to clear).
- [ ] Tutor: show which provider/model answered (already in response headers — surface it in the UI).
- [ ] Search: "did you mean" suggestion when a query returns <3 results.

## 🚧 Blocked (pinged — needs Pepuldo)
When the loop hits a blocker it cannot climb (needs the Vercel URL, KV keys,
OAuth authorized-domain, or a product decision from Pepuldo), it moves the item
HERE, posts to #kb-site-status with --mention --pin --blocker, and KEEPS WORKING on other
features. The --blocker flag maintains an editable "OPEN BLOCKERS" log message
(the bot updates it in place) so it's findable even if the channel lacks pin
permission. Blocked items do not count toward the run's shipped-feature budget.
Format each entry: `- [ ] <feature>: blocked because <reason>. Needs from Pepuldo: <exact ask>.`

