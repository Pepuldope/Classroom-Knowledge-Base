# Classroom Knowledge Base

A Vercel site that does what the original [Classroom Web Analyzer](https://github.com/Pepuldope/Classroom-Web-Analyzer) does — the live study-plan dashboard + per-assignment AI chat — **and adds a private, per-user Knowledge Base**:

- **Your knowledge base**: build a curated study layer in your own browser from your Google Classroom (all years, all courses, coursework, materials, announcements, submissions). It is stored locally in IndexedDB and is not shared with other students.
- **Search**: full-text search your private knowledge base (title/summary/body ranked, fuzzy matching).
- **AI Tutor**: an AI that answers **only** from the knowledge base (retrieval-augmented generation), so it can't make things up. Grounded in the actual notes.

The original Planner and personal Archive views are untouched.

---

## Architecture

```
index.html            UI shell (3 views: Planner / Archive / Knowledge Base)
app.js                Planner + Archive logic (unchanged) + KB view-switch wiring
kb.js                 Knowledge Base module: scrape, search, AI tutor chat (self-contained)
styles.css           styling

api/
  _helpers.js        shared JSON + auth + rate-limit helpers (from original)
  ai.js              AI call helper (from original)
  oauth-*.js         Google OAuth (from original)
  chat.js            per-assignment planner chat (from original)
  kb-store.js        legacy server-side compatibility store for migration and ingestion
  kb-retrieval.js    pure search/scoring over the notes array (mirrors archive.js)
  kb-search.js       GET /api/kb-search   legacy compatibility search route
  kb-scrape.js       POST /api/kb-scrape  legacy ingestion route; active client path stores locally
  tutor.js           POST /api/tutor      server-side tutor for client-supplied notes
```

### Data flow

1. **Build your knowledge base** — the client builds and caches the bundle locally. During migration, `POST /api/kb-scrape` also accepts either:
   - `{source:"classroom", authToken}` → server fetches Classroom via the caller's own read-only token and synthesizes the bundle with `archive-builder.js`'s `bundleFromRaw`.
   - `{source:"bundle", bundle}` → upload an already-built `archive.json` (e.g. from the School Backup pipeline).
2. **Search** — the client runs `searchNotes()` over the cached local bundle; the legacy GET route remains for migration compatibility.
3. **Tutor** — `POST /api/tutor` receives only the notes retrieved in the browser, injects them as grounded context, and streams an answer through the rotating model router.

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
