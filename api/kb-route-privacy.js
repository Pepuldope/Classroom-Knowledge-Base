const ALLOWED_METRICS = new Set(["kb-search", "kb-related", "kb-route"]);

export function contentFreeTiming(metric, durationMs) {
  const rawMetric = typeof metric === "string" ? metric : "";
  const [baseMetric, descriptor] = rawMetric.split(";", 2);
  const safeMetric = ALLOWED_METRICS.has(baseMetric) ? baseMetric : "kb-route";
  const safeDescriptor = baseMetric === "kb-related" && descriptor === "desc=cache"
    ? ";desc=cache"
    : "";
  const duration = Number(durationMs);
  const safeDuration = Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : 0;
  return `${safeMetric}${safeDescriptor};dur=${safeDuration}`;
}
