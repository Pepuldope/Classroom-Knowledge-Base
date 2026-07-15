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

## EXTENDED FOCUS AREAS (owner addendum 2026-07-14)

Beyond the per-user/private pivot, the next runs must also invest in these four
areas. They are standing priorities, not one-offs — fold them into every run's work
order and report on each in the status message.

1. **KB → Settings integration.** The knowledge base should be fully configurable
   from the site's existing **Settings** page, not buried in code/in-code constants.
   Move KB controls into Settings: AI-tutor on/off + effort, default search scope
   (all courses vs current course vs a pinned set), related-notes count, compact vs
   comfortable density, auto-build-on-Classroom-sign-in toggle, and bundle
   export / clear-local-data actions. Reuse the existing Settings UI/state (do not
   build a second settings surface). Persist choices in the user's browser, never
   server-side.

2. **Continuity across the WHOLE site.** Past runs over-focused on the KB and let
   the rest of the app drift. Every change must keep the full app coherent: shared
   CSS, the nav/routing shell, theme, onboarding, and the Archive/Planner views
   must all still work after a KB change. Before reporting "done", open the other
   views (archive, planner, settings, home) and confirm nothing regressed. Treat
   the KB as ONE feature of a multi-view app, not the whole app.

3. **General performance / load times.** Make the whole site feel instant. Concrete
   levers: the per-user/private pivot already removes the multi-shard KV fetch on
   first paint; additionally lazy-load non-critical panels (build panel, tutor,
   related-notes preview), debounce search input, code-split heavy modules, and
   cache the bundle in IndexedDB so repeat visits are instant. Track regressions
   with `scripts/kb_loading_test.mjs` — first paint must show the "Loading your
   knowledge base…" state then populate, with NO multi-second blank wait, and the
   loading e2e must keep passing.

4. **Student privacy (hard requirement).** The KB is per-user/private by design
   (no shared server DB, no public read API, no public export). Extend that
   posture site-wide:
   - No third-party trackers/analytics that see student content.
   - Tutor context leaves the browser ONLY for the model call, and ONLY the
     retrieved notes needed to answer — never the whole bundle, never other
     students' data.
   - The server must NOT log student note content. Log only minimal,
     non-identifying request metadata.
   - Classroom OAuth token is read-only and clearly scoped; surface a plain-language
     consent + a "what gets stored, where" note in Settings.
   - Local-only storage is the default; nothing is uploaded unless the student
     explicitly triggers it.
   - Add a short privacy summary to Settings so students can see the stance.

5. **Persistent Google sign-in.** The user should NOT have to re-authenticate
   with Google Classroom every time the site opens. Persist the Classroom OAuth
   session (access token + refresh token where the provider grants one) in the
   browser (IndexedDB, consistent with the local-only privacy posture) and
   silently rehydrate the session on page load. Surface a clear "Signed in as
   <email> · Sign out" state in Settings; sign-out wipes local creds. Never
   store the token server-side. Keep the read-only Classroom scope + consent
   notice from focus area 4.

6. **Hide the build card once a bundle already exists.** When the KB is already
   built/loaded — a local IndexedDB bundle post-pivot, or a populated server DB
   pre-pivot — the entire "Scrape my Classroom" onboarding card (button + build
   panel + hint) must be hidden; show only the search / study surface. Only
   reveal the build card when there is genuinely no bundle yet (empty state), so
   the user is never shown a redundant "scrape" action over content that is
   already present and loading.

7. **Knowledge-base sorting & filtering.** Add a sort/filter surface so students
   can organize the KB by its real dimensions: **type** (`kind` — assignment,
   note, exam, etc.), **year** (`y`), **class** (`course`), and **class type**
   (`family` — the course-category facet already present in `meta.courseList`,
   e.g. an engineering vs language grouping). Also provide an explicit **sort
   order**: by recency, by course, by title, by relevance. Reuse the existing
   `filters.courses` / `filters.years` machinery and `/api/kb-browse` (which
   already returns courses + note counts and accepts `?course=`) — extend both
   to cover `kind` + `family` + a `sort` param rather than inventing a new
   endpoint. The control must live in the KB view, and focus area 1's Settings
   should let a student pin a default sort/scope. Default: relevance for active
   queries, recency otherwise. Confirm the filter chips + sort actually narrow
   and reorder results (add/extend e2e coverage).

8. **AI tutor → a real in-app chatbot.** Level the tutor up from a single
   fire-and-forget box into a proper mini chatbot inside the KB view. Must-haves:
   - **Clear chat** button (wipe the current conversation, keep grounding scope).
   - **New chat** button (start a fresh thread; optionally keep a short list of
     past threads to switch between — if added, persist threads locally only).
   - **Multi-turn memory:** the conversation history is sent back with each turn
     so the tutor remembers context within a thread (still grounded only on the
     user's retrieved notes — never other students' data, per focus area 4).
   - **Streaming / typing indicator** so long answers don't look like a hang.
   - **Per-message copy** + a visible "answers only from your notes" grounding
     note, and graceful error/retry if a provider fails over.
   - Keep routing through `api/ai-router.js` with `task:"tutor"` and the
     existing provider rotation + NVIDIA 46/min throttle (do NOT pin one model).
   Thread state is local-only (privacy posture); nothing is uploaded except the
   notes needed to answer. Reuse the existing tutor UI/state, don't fork a
   second chat surface. Add/extend e2e for clear + new-chat + multi-turn.

9. **Unify the planner AI with the KB tutor.** The planner view currently has its
   OWN separate AI (a different prompt/provider path than the KB tutor). Make them
   the SAME assistant: one shared grounding + chat engine, so a student gets
   consistent behavior, the same model rotation (`api/ai-router.js` `task:"tutor"`),
   and the same privacy posture (grounded only on their notes/Classroom data, never
   other students'). Concretely: the planner's "ask about this assignment" AI should
   route through the SAME tutor pipeline as the KB chatbot (focus area 8) — reuse
   the tutor module + UI rather than maintaining two AI implementations that can
   drift. They may differ only in the input context (planner = the current
   assignment; KB = the whole bundle / a selected note), not in the engine.

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
