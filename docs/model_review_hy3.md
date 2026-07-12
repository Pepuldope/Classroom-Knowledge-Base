# Code Review — Tencent Hy3 (OpenRouter)

Below is a concrete review of the provided files against the five requested dimensions. I cite file + line-range, severity, and a fix.

---

## 1. Correctness / Bugs

### CRITICAL — `getBundle()` source handling is wrong / loses source on KV path
**File:** `api/kb-store.js` — `getBundle()` (~line 150–165)
```js
const source = !kvAvailable() ? mem.get("kb:src") || "vault" : "vault";
```
On the KV (production) path, `source` is hardcoded to `"vault"`, ignoring the actual stored source (`"classroom"` when a user scraped live). `bundleFromNotes` then stamps `source:"vault"` even for a Classroom-built bundle. Downstream `appendBundle` also forces `source:"vault"` (line ~210), so a live Classroom scrape can later be silently relabeled.
**Fix:** Persist `source` in `META_KEY` (or a `kb:src` KV key) and read it back in `getBundle`/`saveBundle`. In `appendBundle`, preserve `prev.source` unless explicitly overridden.

### HIGH — `appendBundle` overwrites `clusters` and `metadata` from incoming only
**File:** `api/kb-store.js` — `appendBundle()` (~line 195–225)
```js
clusters: prev.clusters || [],
...(incoming.metadata ? { metadata: incoming.metadata } : {}),
```
If a later vault chunk omits `metadata`, the previously stored `metadata` is dropped. Also `generatedAt` is reset every append, losing original build time.
**Fix:** Merge `metadata` (`...(prev.metadata||{}), ...(incoming.metadata||{})`) and keep earliest `generatedAt`.

### MED — `deriveSummary` uses lookbehind regex not supported in all Edge JS engines
**File:** `archive-builder.js` — `deriveSummary()` (~line 330)
```js
const firstSentence = clean.split(/(?<=[.!?])\s/)[0] || "";
```
Lookbehind `(?<=...)` is supported in modern V8 (Edge uses V8) but is a portability risk and can throw on older runtimes.
**Fix:** Use a non-lookbehind split: `clean.match(/[^.!?]+[.!?]*/)[0]` or `clean.split(/[.!?]/)[0]`.

### LOW — `seed-vault.mjs` course detection can mislabel
**File:** `scripts/seed-vault.mjs` — `parseObsidian()` (~line 30–45)
If vault path has no `vault` segment and length ≥2, `course = parts[1]` may grab a year or top folder. Not fatal (KB still populates) but noisy facets.
**Fix:** Prefer explicit `vault` index; else fall back to a known mapping or leave `course:""` → normalized to `"Uncategorized"`.

---

## 2. Edge-runtime safety (no node:fs/path)

- `api/kb-store.js`, `api/ai-router.js`, `api/kb-scrape.js`, `archive-builder.js`: **PASS.** No `node:fs`/`node:path` imports; only `fetch` and pure JS.
- `scripts/seed-vault.mjs`: uses `node:fs/promises` + `node:path` but is a **local offline script** (explicitly documented as such). Acceptable.
- `archive-builder.js` imports `./archive.js` (`foldText`). If `archive.js` imports `node:*` it would break Edge. **MED:** verify `archive.js` is Edge-clean or inline `foldText`.

---

## 3. KV storage / sharding correctness

### HIGH — Shard deletion race / partial read on concurrent writes
**File:** `api/kb-store.js` — `writeSharded()` (~line 75–95)
When `shardCount < prevCount`, deletions happen *after* new shards written but *before* `SHARDS_KEY` updated. A concurrent `readShardedNotes` could read new `SHARDS_KEY` count but old extra shards already deleted → missing notes. Also no atomicity: if process dies mid-write, `SHARDS_KEY` may point to unwritten shards.
**Fix:** Write new shards → write `SHARDS_KEY` → then delete stale shards (readers tolerate missing tail as empty). Or use a versioned key and swap atomically.

### MED — `kvSetJSON` uses POST with JSON body to `/set/` — Upstash expects form or raw
**File:** `api/kb-store.js` — `kvSetJSON()` (~line 55–65)
Upstash REST `/set/<key>` with `Content-Type: application/json` and a JSON-stringified *value* works only if the body is the raw value, not `{value:...}`. Current code sends `JSON.stringify(value)` as body — correct for string values, but for objects it double-stringifies (stored as `"\"{...}\""`). `kvGetJSON` handles both, so functionally OK, but wasteful.
**Fix:** Send raw `value` (already stringified) with `Content-Type: text/plain` or confirm Upstash accepts JSON body as value.

### LOW — `SHARD_NOTES=400` with 1500-char cap → ~600KB/shard; under 2.5KB limit but no margin check
**File:** `api/kb-store.js` (~line 30)
2832 notes / 400 = 8 shards, ~600KB each. Safe, but if bodies grow, risk.
**Fix:** Add a runtime size guard in `writeSharded` (warn if shard JSON > 1MB).

---

## 4. Autonomous-loop robustness

### HIGH — Loop can do cosmetic work on empty KB if `seed-vault.mjs` fails silently
**File:** `SKILL.md` / `AGENTS.md` — acceptance gate
`AGENTS.md` says "prove populated via live search" but `kb-scrape.js` `vault` path returns `meta.noteCount`. If `appendBundle` dedupes all as pathless (`_0`,`_1`…) due to missing `p`, count may look fine but search weak.
**Fix:** In `seed-vault.mjs`, assert `lastMeta.noteCount` increased by ~chunk size; fail if not.

### MED — `ai-router.js` rotation is module-level; serverless cold starts reset counter
**File:** `api/ai-router.js` (~line 120)
`_rotate` resets per invocation → less spread than intended, but failover still works. Not blocking.
**Fix:** Acceptable; document as best-effort.

### LOW — No timeout on `fetch` to AI providers
**File:** `api/ai-router.js` (~line 150)
A hanging provider (e.g. NVIDIA pro) can stall the loop.
**Fix:** Add `AbortSignal.timeout(30000)` per fetch.

---

## 5. Security issues

### HIGH — `kb-store.js` export endpoint is public, no auth
**File:** `api/kb-store.js` (~line 240)
`GET /api/kb-store?action=export` returns full bundle (including any user-scraped Classroom data) to anyone. AGENTS says "shared DB readable by anyone" but Classroom tokens are not stored here — however if `source:"classroom"` notes contain PII, public export is a leak.
**Fix:** At minimum, require a read-only `KB_READ_TOKEN` env check, or remove export from public edge.

### MED — `kb-scrape.js` `classroom` path accepts arbitrary `authToken` and fetches with it
**File:** `api/kb-scrape.js` (~line 70–90)
No verification that the token belongs to a verified user (despite comment "Only verified Google users may write" — `verifyUser` is imported but NOT called).
**Fix:** Call `verifyUser(req)` and reject if not verified, or scope writes to that user's domain.

### LOW — `ai-router.js` FreeLLMAPI defaults to `http://127.0.0.1:3001`
**File:** `api/ai-router.js` (~line 95)
On Vercel Edge, localhost is unreachable; if `FREELLMAPI_API_KEY` is set but base missing, it silently fails over. OK, but could log.
**Fix:** Skip provider if `baseURL` is localhost in production.

---

## VERDICT: SHIP-WITH-FIXES

### Top 3 things to address before next loop run:
1. **Fix `getBundle`/`appendBundle` source persistence + `verifyUser` enforcement in `kb-scrape.js`** (CRITICAL/HIGH security + data correctness).
2. **Make KV shard writes safe (write SHARDS_KEY last; delete stale after)** to avoid partial reads during the every-3h ingestion (HIGH robustness).
3. **Gate the autonomous loop on real `noteCount` growth + live search assertion** with hard failure in `seed-vault.mjs` so it cannot polish an empty KB (HIGH loop discipline).
