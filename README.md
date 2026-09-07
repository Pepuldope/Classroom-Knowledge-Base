# Classroom Knowledge Base

A Vercel site that does what the original [Classroom Web Analyzer](https://github.com/Pepuldope/Classroom-Web-Analyzer) does — the live study-plan dashboard + per-assignment AI chat — **and adds a private, per-user Knowledge Base**:

- **Your notes**: build a curated study layer in your own browser from your Google Classroom (all years, all courses, coursework, materials, announcements, submissions). Stored locally in IndexedDB, never shared.
- **Search**: full-text search across every year at once (title/summary/body ranked, fuzzy matching).
- **AI Tutor**: an AI that answers **only** from your notes (retrieval-augmented generation), so it can't make things up.

Two pages: **Planner** and **Study**. Study was formerly two separate views —
Archive and Knowledge Base — which shared a database, a builder and a note
shape while maintaining two search implementations and two browse UIs. They are
one corpus and one page now; the Curriculum matrix is the part of Archive that
survived, as a tab.

---

## Architecture

```
index.html            UI shell (2 pages: Planner / Study)
app.js                Planner logic, routing, and the "From your notes" strip
kb.js                 Study page: build, search, browse, tabs, AI tutor chat
study-tabs.js         which Study panel is showing (pure)
kb-curriculum.js      the subject × year matrix (pure model + renderer)
kb-merge.js           fold ingested bundles into one corpus (pure)
kb-local.js           IndexedDB persistence for the corpus + build checkpoint
kb-client-search.js   the search/related scorer — the only one, used by the browser
archive.js            shared plumbing: markdown rendering + IndexedDB primitives
archive-builder.js    Classroom fetch + bundle synthesis (bundleFromRaw/bundleFromVault)
styles.css            styling

api/
  _helpers.js        shared JSON + auth + rate-limit helpers
  ai.js              AI call helper
  oauth-*.js         Google OAuth
  chat.js            per-assignment planner chat
  enrich.js          POST /api/enrich     assignment type + time estimate
  kb-store.js        KV store behind vault ingestion (sharded; also derives `family`)
  kb-scrape.js       POST /api/kb-scrape  vault/bundle ingestion — how the automation seeds the live KV
  tutor.js           POST /api/tutor      server-side tutor for client-supplied notes
```

The search, browse, note and related **routes were deleted**: the browser does
all of that against its own local bundle, and nothing called them outside a
localhost test harness. `api/kb-retrieval.js` was a server-side mirror of
`kb-client-search.js` and went with them.

### Data flow

1. **Build** — the client fetches Classroom itself (resumable, per-course
   checkpoint) and **merges** the result into the stored corpus rather than
   replacing it, so a rebuild never discards imported past years and an import
   never discards the build (`kb-merge.js`). `POST /api/kb-scrape` remains for
   server-side vault ingestion, which is how the automation seeds the shared KV
   without an OAuth token.
2. **Search** — `searchNotes()` runs in the browser over the local bundle. No
   round trip, and no note content leaves the device.
3. **Tutor** — `POST /api/tutor` receives only the notes retrieved in the
   browser, injects them as grounded context, and streams an answer through the
   rotating model router.

### Notes schema (reused from archive-builder.js)

```js
{ version:1, source, generatedAt, years:[], courses:[], notes:[
  { t:"Title", s:"summary", x:"body text", course:"Math", y:"2025-26", topic:"Algebra", kind:"note", p:"vault/path" }
]}
```

---

## Local development

```bash
npm i -g vercel
vercel dev            # serves api/ as serverless functions, index.html as static
```

The active knowledge-base bundle is stored in the user's browser with IndexedDB,
so repeat visits are fast and no shared database is needed. The legacy ingestion
compatibility path can still use `KV_REST_API_URL` / `KV_REST_API_TOKEN` during
migration; it must never be treated as a public student-data store.

```bash
# from /opt/data/workspace
node kb_e2e_test.mjs      # parses school-backup vault -> bundle -> saves -> searches (test)
```

## Deploy to Vercel

1. `vercel` → link the repo.
2. Set env vars in the Vercel dashboard:
   - `OPENROUTER_API_KEY` — for the AI tutor (Nemotron free models).
   - `KV_REST_API_URL` + `KV_REST_API_TOKEN` — create an Upstash KV store and paste here. (Without these it falls back to a file, which won't persist across serverless invocations — so set them for production.)
   - The Google OAuth client_id/secret are already in `oauth-config.js` / `app.js` (from the original project). The Classroom **read-only** scopes are already requested.
3. `vercel --prod`.

## First run (build your knowledge base)

1. Open the site, sign in with Google.
2. Go to **Knowledge Base** → "Build my knowledge base".
   (This uses your own read-only Google token; the resulting bundle stays in your browser.)
3. Or click "upload an archive.json" and supply the School Backup export.

---

## Long-term: AI upgrade loop

The site is meant to be continuously improved by the AI fleet. A cron job
(`long-term-site-dev`) periodically reviews the repo against a feature backlog
and proposes/implements UX + feature upgrades, so it keeps getting more
user-friendly and feature-rich over time. See the cron job notes for the
current backlog.
