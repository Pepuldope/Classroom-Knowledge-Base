# Consolidated Code-Review Report — Autonomous KB Loop

*Authored by Hermes (NVIDIA `deepseek-v4-flash` was rate-limited: `ResourceExhausted 394/48` on the free tier at review time; same synthesis a model would produce). Sources: `docs/model_review_deepseek-v4-pro.md`, `docs/model_review_hy3.md`, `docs/model_review_gemini-2.5-flash.md`.*

## 1. TOP ISSUES (ranked by severity)

**CRITICAL — Unauthenticated write endpoint (kb-scrape.js).** The file imports `verifyUser` but **never calls it**, so `POST /api/kb-scrape` accepts any body and overwrites the entire shared KB. Anyone can wipe or poison it.
→ *FIXED in this pass:* added `requireWriteAuth()` — accepts either a verified Google user (`verifyUser`) or a shared `KB_WRITE_TOKEN` sent as `X-KB-Write-Token`. Loop/seed use the secret; the user-facing `classroom` path needs a real Google login. Added 3 e2e tests (401 reject / 200 valid / 401 wrong).

**HIGH — Write-guard token must reach production.** The guard is worthless if `KB_WRITE_TOKEN` isn't set in the live env.
→ *FIXED:* added `KB_WRITE_TOKEN` as a Vercel **Production** env var; `seed-vault.mjs` now sends `X-KB-Write-Token`.

**HIGH — Shard-write ordering race (kb-store.js `writeSharded`).** Deletes stale shards before writing `SHARDS_KEY`; a concurrent read could see new count + missing tail, and a mid-write crash leaves an inconsistent index.
→ Fix: write new shards → write `SHARDS_KEY` → *then* delete stale shards (readers tolerate a missing tail as empty). Also consider an Upstash lock if concurrent user scrapes become possible.

**HIGH — Loop discipline on empty/failed seed (SKILL.md / seed-vault.mjs).** If `appendBundle` dedupes everything as pathless, `noteCount` can look healthy while search is weak; a silent seed failure lets the loop do cosmetic work.
→ Fix: assert `lastMeta.noteCount` grows by ~chunk size in `seed-vault.mjs`; hard-fail if not.

**MED — `getBundle`/`appendBundle` source persistence.** KV path hardcodes `source:"vault"`, dropping a real `"classroom"` origin; `appendBundle` also forces `source:"vault"` and resets `generatedAt`, dropping `metadata`.
→ Fix: persist `source` in `META_KEY`/`kb:src`; in `appendBundle` use `prev.source || incoming.source || "vault"`, merge `metadata`, keep earliest `generatedAt`.

**MED — `bundleFromRaw` (classroom path) sets `s: null`** while AGENTS.md requires a derived summary `s` for the ×3 search weight. Gemini flagged the directive/impl mismatch.
→ Fix: derive `s` in `bundleFromRaw` the same way `bundleFromVault` does.

**LOW — Dead `kb:bundle` key** after sharding migration; **dup Classroom-fetch logic** (`bundleFromRawWithFetch` vs `buildArchiveFromClassroom`); **lookbehind regex** `(?<=...)` in `deriveSummary` (portability risk); **no `AbortSignal.timeout`** on AI `fetch` (a hung provider can stall the loop).

## 2. CONSENSUS vs DISAGREEMENT
- **Consensus:** the unauthenticated write endpoint is the #1 problem (DeepSeek-pro + Hy3 both CRITICAL/HIGH; Gemini was truncated but flagged `bundleFromRaw` `s:null` discrepancy). Edge-runtime safety and sharding *logic* are sound.
- **Disagreement:** DeepSeek-pro flagged a phantom `BUNDLE_KEY` write (it's defined but unused — harmless dead data, not a bug). Hy3 over-weighted shard-race severity (acceptable for single-writer loop).

## 3. VERDICT: SHIP-WITH-FIXES
The critical auth hole is now closed and tested. Remaining items are robustness/correctness, not blockers.

**3 must-do:**
1. (done) Enforce write auth on `/api/kb-scrape` + set `KB_WRITE_TOKEN` in prod.
2. Reorder shard writes so `SHARDS_KEY` is written last; delete stale shards after.
3. Persist `source`/`metadata`/`generatedAt` correctly through `appendBundle` and `getBundle`.

## 4. Prioritized TODO
1. `kb-store.js`: reorder `writeSharded` (write SHARDS_KEY before deletes) + persist `source` in meta + merge metadata in `appendBundle`.
2. `archive-builder.js`: derive `s` in `bundleFromRaw`; replace lookbehind split with `match(/[^.!?]+[.!?]*/)`.
3. `ai-router.js`: add `AbortSignal.timeout(30000)` per provider fetch.
4. `kb-scrape.js`: reuse `buildArchiveFromClassroom` instead of local `bundleFromRawWithFetch`; delete legacy `kb:bundle` key on first sharded write.
5. `seed-vault.mjs`: assert noteCount growth; hard-fail on regression.
