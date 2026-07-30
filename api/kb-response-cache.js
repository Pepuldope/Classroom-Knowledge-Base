// Small pure cache guard for the legacy KB search compatibility route.
// Cache entries are tied to the exact in-memory bundle object, so any ingestion
// write that replaces the bundle naturally makes old responses unusable.

export const SEARCH_RESPONSE_CACHE_TTL_MS = 10_000;

export function searchResponseCacheState(
  entry,
  key,
  bundle,
  now = Date.now(),
  ttl = SEARCH_RESPONSE_CACHE_TTL_MS,
) {
  if (!entry || entry.key !== key || entry.bundle !== bundle || !entry.response) return null;
  const cachedAt = Number(entry.cachedAt);
  const age = Number(now) - cachedAt;
  if (!Number.isFinite(cachedAt) || !Number.isFinite(age) || age < 0 || age > ttl) return null;
  return entry.response;
}
