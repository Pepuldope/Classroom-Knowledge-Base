# Classroom Knowledge Base

A Vercel site that does what the original [Classroom Web Analyzer](https://github.com/Pepuldope/Classroom-Web-Analyzer) does — the live study-plan dashboard + per-assignment AI chat — **and adds a shared Knowledge Base**:

- **Safekeep DB**: scrape your whole Google Classroom (all years, all courses, coursework, materials, announcements, submissions) into ONE server-side database that every student shares.
- **Search**: anyone can full-text search the knowledge base (title/summary/body ranked, fuzzy matching).
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
  kb-store.js        shared DB: Upstash KV (Edge-compatible, via Web fetch) — no filesystem
  kb-retrieval.js    pure search/scoring over the notes array (mirrors archive.js)
  kb-search.js       GET /api/kb-search   public search
  kb-scrape.js       POST /api/kb-scrape  persist a Classroom bundle into the DB
  tutor.js           POST /api/tutor      streaming RAG tutor (OpenRouter Nemotron)
```

### Data flow

1. **Build the safekeep** — `POST /api/kb-scrape` with either:
   - `{source:"classroom", authToken}` → server fetches Classroom via the caller's own read-only token and synthesizes the bundle with `archive-builder.js`'s `bundleFromRaw`, then saves to the shared DB.
   - `{source:"bundle", bundle}` → upload an already-built `archive.json` (e.g. from the School Backup pipeline).
2. **Search** — `GET /api/kb-search?q=...` runs `searchNotes()` over the stored bundle.
3. **Tutor** — `POST /api/tutor` retrieves the top notes for the question, injects them as grounded context, and streams an answer from an OpenRouter model.

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

Without `KV_REST_API_URL` / `KV_REST_API_TOKEN` set, `kb-store.js` falls back to a
process-memory store so the flow can be developed locally with `vercel dev`.
That memory store is NOT durable across serverless invocations, so **production
must set the KV env vars** (below) or the safekeep resets on each cold start.

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

## First run (populate the safekeep)

1. Open the site, sign in with Google.
2. Go to **Knowledge Base** → "Scrape my Classroom into the shared DB".
   (This uses your own Google token; only you, the owner, can write. Anyone can search + ask the tutor afterward.)
3. Or click "upload an archive.json" and supply the School Backup export.

---

## Long-term: AI upgrade loop

The site is meant to be continuously improved by the AI fleet. A cron job
(`long-term-site-dev`) periodically reviews the repo against a feature backlog
and proposes/implements UX + feature upgrades, so it keeps getting more
user-friendly and feature-rich over time. See the cron job notes for the
current backlog.
