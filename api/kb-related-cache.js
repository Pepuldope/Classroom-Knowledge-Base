// Pure cache guard for the legacy KB related compatibility route.
// Entries are tied to the exact bundle object so incremental ingestion writes
// cannot reuse responses computed from an older corpus.

export const RELATED_RESPONSE_CACHE_TTL_MS = 10_000;

export function relatedResponseCacheState(
  entry,
  key,
  bundle,
  now = Date.now(),
  ttl = RELATED_RESPONSE_CACHE_TTL_MS,
) {
  if (!entry || entry.key !== key || entry.bundle !== bundle || !entry.response) return null;
  const cachedAt = Number(entry.cachedAt);
  const age = Number(now) - cachedAt;
  if (!Number.isFinite(cachedAt) || !Number.isFinite(age) || age < 0 || age > ttl) return null;
  return entry.response;
}
