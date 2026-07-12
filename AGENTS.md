# AGENTS.md — Classroom Knowledge Base (autonomous dev)

## CURRENT PRIORITY (focus for this and near-future passes)
Pepuldo's complaint: the shared KB only shows **1 note and 1 class ("Demo")**.
He wants the next passes to focus on **how the KB scrapes/ingests files and how it
then lets you search through them.**

### How the pipeline works (verified — do not re-derive from scratch)
- The KB is a SEPARATE feature from the main Classroom report. It stores a
  "bundle" of notes server-side (Vercel KV via `api/kb-store.js`).
- Ingestion: `POST /api/kb-scrape`
  - `{source:'classroom', authToken}` → uses the caller's Google token to fetch
    courses + courseWork + courseWorkMaterials + announcements + studentSubmissions,
    then `bundleFromRaw()` (archive-builder.js) synthesizes notes. Returns
    `meta {noteCount, courseCount}`.
  - `{source:'bundle', bundle}` → caller supplies a prebuilt bundle.
- Synthesis (`bundleFromRaw`): each courseWork / material / announcement becomes a
  note `{ t:title, course, y:year, topic, kind, s:null, x:body(markdown), p:path }`.
  NOTE: `s` (summary) is ALWAYS null → the ×3 summary weight in search never fires.
- Search: `GET /api/kb-search?q=&course=&year=` → `searchNotes()` (kb-retrieval.js):
  weights title×5, summary×3, body×1, +2 if all tokens present. Returns
  `{ meta, results, filters:{courses,years} }`. Course/topic are only FILTERS, not
  ranking signals — searching a course/topic name does NOT boost matching notes.
- Related: `GET /api/kb-related?id=` → `relatedNotes()` (fixed last pass; fast,
  exact-token overlap).
- The live site currently holds ONLY the demo seed (1 note "Sample class note",
  course "Demo") because no real scrape has been performed. A real corpus already
  exists locally at `/opt/data/school-backup` (2832 .md files) from the offline
  "School Backup" pipeline — a candidate real ingestion source.

### Goals (TDD — write a failing test first, then implement)
1. **Populate the KB with real content** so it is not stuck at the demo seed.
   Prefer adding a `source:'vault'` ingestion (or a dev seed script) that turns a
   directory of markdown (e.g. `/opt/data/school-backup`) into notes via a
   `bundleFromRaw`-compatible shape, so search has real material AND the autonomous
   gate can verify it WITHOUT a live Google token. Keep the live
   `{source:'classroom', authToken}` path working.
2. **Make search rank by course & topic**, not just filter. Add course/topic as
   weighted indexed fields (e.g. course×2) so "Algebra quadratic" boosts Algebra
   notes. Keep the filters too.
3. **Derive a summary `s`** for each note (e.g. first sentence of body, or
   `${course} · ${topic}: ${title}`) so the ×3 summary weight is useful and
   snippets improve.
4. **Snippet quality**: notes with empty body `x` yield empty snippets today —
   ensure every result has a usable snippet (fall back to title/topic).
5. **End-to-end verification (the acceptance gate)**: seed many real notes
   (vault or fixture, ≥50), then assert:
   - `/api/kb-search?q=<real term>` returns relevant, ranked, snippet-bearing
     results (NOT the empty set).
   - `/api/kb-related?id=<n>` returns related notes in <1s over the corpus
     (regression guard from last pass).
   - `/api/kb-search` `filters.courses` / `filters.years` are populated
     (≥ multiple courses).

### Guardrails (unchanged)
- TDD only (software-development:test-driven-development). Red → green.
- Never push a change the gate doesn't pass. Never push if the gate can't run
  (port 4321 must be free; kill any stale `dev-server.mjs` first).
- `relatedNotes` must stay <1s on a few-hundred-note corpus — the loop's own 5s
  curl timeout fails the whole run otherwise.
- Report a concise status to the kb-site-status Discord channel.
- Prefer minimal, well-tested changes; don't rewrite working code gratuitously.

## Project layout (quick refs)
- `api/kb-scrape.js` — ingestion handler (classroom token + bundle paths)
- `api/kb-store.js` — KV persistence (`saveBundle` / `getBundle` / `getMeta`)
- `api/kb-search.js`, `api/kb-related.js` — read routes
- `api/kb-retrieval.js` — `searchNotes()` + `relatedNotes()` (pure, node-tested)
- `archive-builder.js` — `bundleFromRaw()` + note-body synthesis (pure, node-tested)
- `kb.js` — front-end (scrape button, search UI, related panel)
- `scripts/kb_e2e_test.mjs` — API/retrieval tests (`node --test`)
- `scripts/kb_ui_test.mjs` — Playwright UI e2e (via `scripts/test.sh 4321`)
