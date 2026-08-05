const DEFAULT_BUDGET_MS = 100;

function percentileNearestRank(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(sorted.length * percentile));
  return sorted[rank - 1];
}

export function summarizeWarmTransitionSamples(samples, budgetMs = DEFAULT_BUDGET_MS) {
  if (!Array.isArray(samples) || samples.length < 3) {
    throw new Error("requires at least three warm samples");
  }
  const values = samples.map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("transition samples must be finite non-negative numbers");
  }
  const budget = Number(budgetMs);
  if (!Number.isFinite(budget) || budget < 0) throw new Error("budget must be finite");
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    averageMs: total / values.length,
    maxMs: Math.max(...values),
    p95Ms: percentileNearestRank(values, 0.95),
    budgetMs: budget,
    withinBudget: percentileNearestRank(values, 0.95) <= budget,
  };
}
