# Code Review — DeepSeek v4 Pro (OpenRouter)

**Code Review: Classroom Knowledge Base Autonomous Loop**

---

### 1. Missing authentication on the write endpoint (Critical)

**File:** `api/kb-scrape.js`, lines 1–3 (imports) and the handler body (lines ~20–80)  
**Severity:** **Critical** (allows unauthenticated overwrite of the shared Knowledge Base)

The file imports `verifyUser` from `./_helpers.js` but **never calls it**. The comment at line ~10 states *“Only verified Google users may write”*, yet the handler processes any POST without checking identity. An attacker can send `POST /api/kb-scrape` with `{ source: "bundle", bundle: { version:1, notes:[] } }` and wipe the entire KB, or inject arbitrary notes.

**Fix:**  
At the top of the handler, after parsing the body, add an authentication guard. For example:
```javascript
const user = await verifyUser(req);
if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
```
If the autonomous loop itself needs to write without a Google user (e.g., from `seed-vault.mjs`), provide a shared secret (e.g., `X-API-Key` header) and validate it alongside or instead of the Google token.

---

### 2. `appendBundle` hardcodes `source: "vault"` (Low)

**File:** `api/kb-store.js`, line ~130 (`const merged = { ... source: "vault", ... }`)  
**Severity:** **Low** (latent bug if `appendBundle` is ever called with classroom data)

The function always sets `source: "vault"` in the merged bundle, ignoring any source that might have been present in the incoming data. Currently it is only used for vault ingestion, so no immediate harm, but if the classroom path ever uses `appendBundle` (e.g., incremental updates), the source metadata would be wrong.

**Fix:**  
Preserve the source from the incoming bundle or allow an override:
```javascript
source: incoming.source || prev.source || "vault",
```

---

### 3. Old `kb:bundle` key never cleaned up after sharding migration (Low)

**File:** `api/kb-store.js`, lines ~15–16 (constants `BUNDLE_KEY` and `META_KEY`) and `writeSharded` (line ~70)  
**Severity:** **Low** (wasted storage, no functional impact)

The code defines `BUNDLE_KEY = "kb:bundle"` but never writes to it after sharding was introduced. If the KV store previously held a large single-key bundle, that key remains and consumes space. No read path uses it, so it’s harmless, but it’s dead data.

**Fix:**  
During the first sharded write, delete the old `kb:bundle` key if it exists. Add a one‑time cleanup in `writeSharded`:
```javascript
// After writing shards, delete legacy single-key bundle if present
await fetch(`${KV_URL}/del/${encodeURIComponent(BUNDLE_KEY)}`, { … });
```

---

### 4. Duplicate Classroom‑fetch logic (Low)

**File:** `api/kb-scrape.js`, lines ~85–130 (function `bundleFromRawWithFetch`)  
**Severity:** **Low** (maintenance risk, not a runtime bug)

The handler defines a local `bundleFromRawWithFetch` that replicates the course‑by‑course fetching logic from `archive-builder.js`’s `buildArchiveFromClassroom`, but without concurrency, progress reporting, or graceful facet skipping. The two implementations will diverge.

**Fix:**  
Import and reuse `buildArchiveFromClassroom` directly:
```javascript
import { buildArchiveFromClassroom } from "../archive-builder.js";
// inside handler:
const bundle = await buildArchiveFromClassroom(gFetch);
```
This eliminates duplication and ensures the same robust fetching (concurrency, error handling) is used everywhere.

---

### 5. Potential race condition on concurrent shard writes (Low)

**File:** `api/kb-store.js`, `writeSharded` (lines ~55–80)  
**Severity:** **Low** (the loop is single‑writer, but concurrent user scrapes could interleave)

`writeSharded` reads the old shard count, writes new shards, then deletes extra shards. If two requests run simultaneously, one could delete shards that the other just wrote, or the shard index could become inconsistent.

**Fix:**  
For a single‑writer system this is acceptable, but if concurrent writes become possible, use Upstash KV transactions (MULTI/EXEC) or a distributed lock. For now, document the assumption.

---

### 6. Edge‑runtime safety ✅

All API modules (`kb-store.js`, `ai-router.js`, `kb-scrape.js`, `archive-builder.js`) use only Web‑standard `fetch` and `process.env`. No `node:fs`, `node:path`, or other Node‑only APIs are imported. The seed script (`seed-vault.mjs`) correctly runs offline with Node.js. **No Edge‑runtime violations.**

---

### 7. KV sharding correctness ✅

The sharding logic (`SHARD_NOTES = 400`, `writeSharded`, `readShardedNotes`) correctly splits and reassembles notes. The `getBundle` function properly awaits `readShardedNotes()` in both KV and memory branches (the earlier bug is fixed). Body capping at 1500 characters keeps shard sizes safe. **Sharding is correct.**

---

### 8. Autonomous‑loop robustness ✅

The loop’s instructions (AGENTS.md, SKILL.md) enforce functional‑first priorities, acceptance gates (live search must return hundreds of notes), and flush‑guard discipline. The seed script chunks uploads to avoid 413 errors. The AI router rotates providers and handles failover. **The loop design is robust.**

---

### VERDICT: **BLOCK** (until critical auth issue is resolved)

**Top 3 things to address before shipping:**
1. **Add authentication to `POST /api/kb-scrape`** – the endpoint is completely unprotected despite the comment promising otherwise.
2. **Clean up the legacy `kb:bundle` key** to avoid confusion and wasted storage.
3. **Deduplicate the Classroom fetch logic** by reusing `buildArchiveFromClassroom` from `archive-builder.js`.
