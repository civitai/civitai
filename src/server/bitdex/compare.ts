import client from 'prom-client';

// HMR-safe metric registration (same pattern as prom/client.ts)
function registerHistogram<T extends string>(opts: {
  name: string;
  help: string;
  labelNames?: readonly T[];
  buckets: number[];
}) {
  try {
    return new client.Histogram(opts);
  } catch {
    return client.register.getSingleMetric(opts.name) as client.Histogram<T>;
  }
}

function registerCounter<T extends string>(opts: {
  name: string;
  help: string;
  labelNames?: readonly T[];
}) {
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

// Jaccard similarity of result ID sets, labeled by sort and query class
const overlapHistogram = registerHistogram({
  name: 'bitdex_shadow_result_overlap',
  help: 'Jaccard similarity of result ID sets (0-1)',
  labelNames: ['sort', 'query_class'] as const,
  buckets: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0],
});

// Difference in total_matched between engines
const totalMatchedDiffHistogram = registerHistogram({
  name: 'bitdex_shadow_total_matched_diff',
  help: 'Absolute difference in total_matched counts',
  buckets: [0, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000],
});

// Whether result ordering matched, labeled by sort
const orderMatchCounter = registerCounter({
  name: 'bitdex_shadow_order_match_total',
  help: 'Count of queries where result ordering matched or not',
  labelNames: ['matched', 'sort'] as const,
});

// BitDex query errors
const errorCounter = registerCounter({
  name: 'bitdex_shadow_errors_total',
  help: 'Count of BitDex shadow query errors',
  labelNames: ['type'] as const, // 'timeout', 'connection', 'other'
});

// Documents the feed's publication filter held back on `sortAt` alone — their
// own `publishedAt` was already past, so they are probably published content
// hidden by index drift rather than genuinely-unpublished content caught.
//
// Deliberately UNLABELLED. A labelled counter publishes no series at all until
// its first observation, and an alert over an absent series renders as "No data"
// — indistinguishable from a healthy zero. (That is not hypothetical: BitDex's
// own `activation_verify_inconclusive_total` is absent on the serving pod for
// exactly this reason, measured 2026-08-17.) Unlabelled, this registers at 0 on
// process start, so an alert on it can actually fire.
// Three names rather than one series with a `mode` label, for the same reason
// they are unlabelled at all: the three cases must be separable (an alert
// threshold cannot mean different things depending on a flag), and each must
// publish a zero from process start so an alert over any of them can fire before
// its first event.
//
// The shadow one is not decoration. Shadow mode exists to size a risk before
// taking it, so a counter that only observes the serving path reads zero until a
// cohort is flipped — measuring the exposure only after it has been taken.
const sortAtOnlyHoldCounterServing = registerCounter({
  name: 'bitdex_feed_sortat_only_holds_total',
  help: 'Feed documents held back by the publication filter on sortAt alone (publishedAt was already past), on requests BitDex served',
});

const sortAtOnlyHoldCounterShadow = registerCounter({
  name: 'bitdex_feed_sortat_only_holds_shadow_total',
  help: 'Feed documents the publication filter WOULD have held back on sortAt alone, on shadow-mode requests where Meili served',
});

const sortAtOnlyHoldCounterFallback = registerCounter({
  name: 'bitdex_feed_sortat_only_holds_fallback_total',
  help: 'Feed documents held back on sortAt alone on requests where the hold emptied the result and Meili served instead (so nothing was hidden from the user)',
});

/**
 * Record documents held back on `sortAt` alone by the feed publication filter.
 *
 * Three modes, three names, because they mean different things to an operator:
 * `serving` hid content from a user, `shadow` would have hidden it had the flag
 * been on, and `fallback` held documents but Meili then served the request — so
 * the user saw them anyway. Folding `fallback` into `serving` would make the
 * alert loudest in the case where the guard cost the user nothing.
 */
export function recordSortAtOnlyHolds(
  count: number,
  mode: 'serving' | 'shadow' | 'fallback'
): void {
  if (count <= 0) return;
  if (mode === 'serving') sortAtOnlyHoldCounterServing.inc(count);
  else if (mode === 'shadow') sortAtOnlyHoldCounterShadow.inc(count);
  else sortAtOnlyHoldCounterFallback.inc(count);
}

interface ComparisonInput {
  bitdexIds: number[];
  meiliIds: number[];
  bitdexTotalMatched: number;
  meiliTotalMatched: number;
  bitdexElapsedMs: number;
  meiliElapsedMs: number;
  sort?: string;
  hasPeriod?: boolean;
  hasFilters?: boolean;
}

export function compareBitdexResults(comparison: ComparisonInput): void {
  const sort = comparison.sort ?? 'unknown';
  const queryClass = comparison.hasPeriod
    ? comparison.hasFilters
      ? 'complex'
      : 'period'
    : comparison.hasFilters
    ? 'filtered'
    : 'simple';

  // Record latencies
  queryDurationHistogram.observe({ source: 'bitdex' }, comparison.bitdexElapsedMs / 1000);
  queryDurationHistogram.observe({ source: 'meilisearch' }, comparison.meiliElapsedMs / 1000);

  // Jaccard similarity — labeled by sort and query class
  const meiliSet = new Set(comparison.meiliIds);
  const intersection = comparison.bitdexIds.filter((id) => meiliSet.has(id)).length;
  const union = new Set([...comparison.bitdexIds, ...comparison.meiliIds]).size;
  const jaccard = union > 0 ? intersection / union : 1.0;
  overlapHistogram.observe({ sort, query_class: queryClass }, jaccard);

  // Total matched diff
  const diff = Math.abs(comparison.bitdexTotalMatched - comparison.meiliTotalMatched);
  totalMatchedDiffHistogram.observe(diff);

  // Order match — labeled by sort
  const orderMatch =
    comparison.bitdexIds.length === comparison.meiliIds.length &&
    comparison.bitdexIds.every((id, i) => id === comparison.meiliIds[i]);
  orderMatchCounter.inc({ matched: orderMatch ? 'true' : 'false', sort });
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
