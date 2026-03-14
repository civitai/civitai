import client from 'prom-client';

// HMR-safe metric registration (same pattern as prom/client.ts)
function registerHistogram<T extends string>(opts: { name: string; help: string; labelNames?: readonly T[]; buckets: number[] }) {
  try {
    return new client.Histogram(opts);
  } catch {
    return client.register.getSingleMetric(opts.name) as client.Histogram<T>;
  }
}

function registerCounter<T extends string>(opts: { name: string; help: string; labelNames?: readonly T[] }) {
  try {
    return new client.Counter(opts);
  } catch {
    return client.register.getSingleMetric(opts.name) as client.Counter<T>;
  }
}

// Latency histogram for both engines
const queryDurationHistogram = registerHistogram({
  name: 'bitdex_shadow_query_duration_seconds',
  help: 'Query duration in seconds',
  labelNames: ['source'] as const, // 'bitdex' or 'meilisearch'
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// Jaccard similarity of result ID sets
const overlapHistogram = registerHistogram({
  name: 'bitdex_shadow_result_overlap',
  help: 'Jaccard similarity of result ID sets (0-1)',
  buckets: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0],
});

// Difference in total_matched between engines
const totalMatchedDiffHistogram = registerHistogram({
  name: 'bitdex_shadow_total_matched_diff',
  help: 'Absolute difference in total_matched counts',
  buckets: [0, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000],
});

// Whether result ordering matched
const orderMatchCounter = registerCounter({
  name: 'bitdex_shadow_order_match_total',
  help: 'Count of queries where result ordering matched or not',
  labelNames: ['matched'] as const, // 'true' or 'false'
});

// BitDex query errors
const errorCounter = registerCounter({
  name: 'bitdex_shadow_errors_total',
  help: 'Count of BitDex shadow query errors',
  labelNames: ['type'] as const, // 'timeout', 'connection', 'other'
});

interface ComparisonInput {
  bitdexIds: number[];
  meiliIds: number[];
  bitdexTotalMatched: number;
  meiliTotalMatched: number;
  bitdexElapsedMs: number;
  meiliElapsedMs: number;
}

export function compareBitdexResults(comparison: ComparisonInput): void {
  // Record latencies
  queryDurationHistogram.observe({ source: 'bitdex' }, comparison.bitdexElapsedMs / 1000);
  queryDurationHistogram.observe({ source: 'meilisearch' }, comparison.meiliElapsedMs / 1000);

  // Jaccard similarity
  const meiliSet = new Set(comparison.meiliIds);
  const intersection = comparison.bitdexIds.filter((id) => meiliSet.has(id)).length;
  const union = new Set([...comparison.bitdexIds, ...comparison.meiliIds]).size;
  const jaccard = union > 0 ? intersection / union : 1.0;
  overlapHistogram.observe(jaccard);

  // Total matched diff
  const diff = Math.abs(comparison.bitdexTotalMatched - comparison.meiliTotalMatched);
  totalMatchedDiffHistogram.observe(diff);

  // Order match -- compare the sequence of overlapping IDs
  const orderMatch =
    comparison.bitdexIds.length === comparison.meiliIds.length &&
    comparison.bitdexIds.every((id, i) => id === comparison.meiliIds[i]);
  orderMatchCounter.inc({ matched: orderMatch ? 'true' : 'false' });
}

export function recordBitdexError(err: unknown): void {
  const errObj = err instanceof Error ? err : new Error(String(err));
  const type =
    errObj.name === 'AbortError'
      ? 'timeout'
      : errObj.message?.includes('ECONNREFUSED')
        ? 'connection'
        : 'other';
  errorCounter.inc({ type });
}
