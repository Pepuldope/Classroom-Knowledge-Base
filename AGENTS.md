# AGENTS.md — Classroom Knowledge Base (autonomous dev)

> **AUTHORITATIVE STEERING.** This file is read by the autonomous loop on every
> run and OVERRIDES the standing cron prompt. If this file and the cron prompt
> disagree, follow this file.

## ARCHITECTURE PIVOT (owner decision 2026-07-14) — per-user / PRIVATE, not shared server DB

The owner rejected the "shared school safekeep" concept (it was a public, server-side
KV database everyone could read and even export). **The knowledge base is now
PER-USER and PRIVATE**, mirroring how the existing Archive feature works: the bundle
lives in the user's OWN browser (IndexedDB), built from their Google Classroom via
their own read-only token. There is NO shared server database, NO public read API, and
NO public export. This also fixes the slow-load complaint: there is no network
round-trip to a 13-shard KV store on first paint — data is local and instant.

Migration plan (in priority order — do these on the next run, then keep improving):

1. **Move the KB bundle from server KV to the client.** Replace the `/api/kb-store`,
   `/api/kb-scrape`, `/api/kb-search`, `/api/kb-browse`, `/api/kb-related`,
   `/api/kb-note` server routes with client-side equivalents that read/write the
   bundle in IndexedDB (reuse `archive.js`'s `idbGet`/`idbPut`/`loadArchiveFromDisk`
   pattern — do NOT invent a new storage layer). Search/related/browse run over the
   in-memory bundle (the same `searchNotes`/`relatedNotes` functions already exist
   in `kb-retrieval.js`, pure + DOM-free).
2. **Keep the AI tutor server-side** (it needs the model router + rate limit), but
   send the user's retrieved notes along with the query instead of having the server
   read a shared DB. The tutor route should accept `{ messages, notes }` where the
   client does the retrieval and ships the grounded context.
3. **Rename everywhere:** "safekeep" → "your knowledge base"; "shared DB" → removed;
   "Scrape my Classroom into the shared DB" → "Build my knowledge base". The
   onboarding + build-hint copy in `index.html` and `kb.js` are already updated —
   finish the rest (README, ROADMAP, api/* comments, docs/).
4. **Verification after pivot:** `/api/kb-search` (now client-side) must return
   results over a few-thousand-note local bundle in well under 1s (no shard fetch);
   the first paint must show the new "Loading your knowledge base…" state, then the
   populated surface, with NO multi-second blank wait.

Until the pivot lands, the existing server routes still back the live site — do not
delete them until the client path is live and verified, or the KB goes dark.

## WHAT THE KB IS (vs the archive)
- **Archive** = raw Classroom export (full dump, planner/archive views). Source data.
- **Knowledge Base** = a CURATED, SEARCHABLE study layer built FROM Classroom
  content. Each note has its own schema:
  `{ t:title, course, y:year, topic, kind, s:summary, x:body(markdown), p:path }`.
  The KB synthesizes study value the raw archive lacks: derived summaries (`s`),
  topics, weighted search, and snippets.
- **Never** collapse KB into archive. The KB ingests FROM the archive but is a
  distinct, usable study surface with its own UI and data shape.

## STANDING ENGINEERING DISCIPLINE (search-before-build)
Before writing new code, REUSE FIRST. Check in this order and **show what you
checked** before implementing:
1. **Current codebase** — existing function/module/pattern?
2. **Existing utilities** — `lib/`, `utils/`, `scripts/`, shared helpers?
3. **Installed dependencies** — already in `package.json`/lockfile?
4. **Official docs** — documented API/config for the need?
5. **Known issue threads** — exact error/behavior on GitHub/SO?
Prefer reuse, config, or a standard library over custom code. Build from scratch
only if nothing fits OR custom code is clearly simpler and safer. Full rule +
workflow: Hermes skill `search-before-build`.
**Web-search caution:** do NOT web-search (rungs 4–5) for trivial local edits
(typo, rename, one-liner, wiring an existing export) — that adds latency and noise.
Reserve web search for external APIs, uncertain framework behavior, real bugs, and
nontrivial architecture decisions. Then: check → plan → implement → test.

## PER-RUN WORK ORDER (functional-first)
0. **PROVE IT IS POPULATED.** After ANY ingestion change, hit the live
   `https://classroom-knowledge-google.vercel.app/api/kb-search?q=<real term>`
   and assert `results.length > 0` AND `meta.noteCount` is realistic (hundreds+).
   If it is still ~1, the run is NOT done — keep working.
1. **INGESTION (top priority — unblocks everything).** The loop cannot use a live
   Google Classroom OAuth token, so use the server-side **vault ingestion**:
   - `POST /api/kb-scrape` with `{ source:"vault", notes:[...] }` →
     `bundleFromVault()` (archive-builder.js) synthesizes KB notes (derives
     `s` summaries, course/year/topic facets). Edge-safe (no node:fs).
   - Seed from the real vault at `/opt/data/school-backup` (2832 .md files) with
     `node scripts/seed-vault.mjs live` (one-time fill of the live KV). Re-run it
     whenever the corpus should refresh.
   - Keep the live `{ source:"classroom", authToken }` path working for real users
     who click "Scrape my Classroom". NOTE: Vercel Edge functions hard-timeout at
     ~10s, so the classroom path is RESUMABLE + INCREMENTAL (client drives
     `mode:"list"` then `mode:"course"` per course, each saved via appendBundle).
     Never revert to a single-shot full scrape — it 504s on a real classroom.
   - Tests live in `scripts/kb_e2e_test.mjs` (covers `bundleFromVault` + the
     resumable classroom list/course flow with a mocked Classroom API).
2. **SEARCH QUALITY.** Rank by **course AND topic** as weighted indexed fields
   (not only filters), so "Algebra quadratic" boosts Algebra notes. Derive a
   summary `s` per note so the ×3 summary weight fires. Guarantee every result
   has a usable snippet (fall back to title/topic when body empty).
3. **THEN light UX polish** (centering, spacing) — but never as a substitute for
   being populated and searchable.
4. **AI TUTOR variety.** Route tutor calls through `api/ai-router.js` with
   `task:"tutor"`. The router now ROTATES across NVIDIA / Gemini / Groq / Mistral
   / Cerebras / GitHub / Qwen / FreeLLMAPI / OpenRouter and uses effort profiles
   (hard/tutor/quick). Do NOT pin the tutor to one model or provider. More models
   + more effort = better answers.
   - **NVIDIA hard limit:** the whole NVIDIA API key must stay **under 48
     requests/minute** (key-wide, not per-model). `api/ai-router.js` enforces this
     with a 46/min sliding-window throttle on the `nvidia` provider — when the cap
     is hit it fails over to the next provider instead of exhausting the key. Do
     not raise `rpmLimit` above 47.

## COMMIT / DEPLOY DISCIPLINE (hard rules)
- TDD only (software-development:test-driven-development). Red → green.
- Commit + push + **`bash scripts/deploy.sh`** after EVERY change (never hoard).
- **FLUSH GUARD:** end of run, check `git status`; if green-but-uncommitted work
  exists, commit/push/deploy it before reporting. Never leave master dirty.
- `relatedNotes` must stay <1s on a few-hundred-note corpus.
- Report a concise status to the `#kb-site-status` Discord channel.

## ACCEPTANCE GATE (the run is only "done" when ALL hold)
- `/api/kb-search?q=<real term>` returns relevant, ranked, snippet-bearing
  results over a corpus of hundreds of real notes (NOT the empty set).
- `/api/kb-search` `filters.courses` / `filters.years` list MANY courses/years.
- `/api/kb-related?id=<n>` returns related notes in <1s.
- Live site redeployed and the live e2e (`KB_LIVE_URL` set) passes.
