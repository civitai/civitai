import { registerCounterWithLabels, registerHistogram } from '@civitai/telemetry/client';

// The search engine comparison (docs/features/search-engine-comparison.md). `cohort` is the arm
// the viewer is in; `served_by` is the engine that answered. An OpenSearch-cohort query that fell
// back is cohort=opensearch, served_by=meilisearch, so cohort totals compare the arms as assigned
// and served_by shows how much of an arm the new engine really carried.

export type SearchEngine = 'meilisearch' | 'opensearch';
export type FallbackReason = 'unsupported' | 'error' | 'unconfigured';

export const siteSearchQueriesCounter = registerCounterWithLabels({
  name: 'site_search_queries_total',
  help:
    'Site search queries answered, once each, by comparison cohort, the engine that answered, ' +
    'index, and whether any hit came back (hits=none|some). hits=none / total per cohort is the ' +
    'zero-result rate.',
  labelNames: ['cohort', 'served_by', 'index', 'hits'] as const,
});

export const siteSearchFallbacksCounter = registerCounterWithLabels({
  name: 'site_search_fallbacks_total',
  help:
    'OpenSearch-cohort queries answered by Meilisearch instead, by reason: unsupported (a request ' +
    'the OpenSearch path does not translate), error (OpenSearch failed or timed out), unconfigured ' +
    '(no OPENSEARCH_URL). Each is also counted once in site_search_queries_total.',
  labelNames: ['index', 'reason'] as const,
});

export const siteSearchDurationHistogram = registerHistogram({
  name: 'site_search_duration_seconds',
  help:
    'Time to answer one site search query, as the API pod sees it (engine round trip included), ' +
    'by comparison cohort, the engine that answered and index. A multi-search to Meilisearch is ' +
    'one round trip, so each of its queries records that whole round trip.',
  labelNames: ['cohort', 'served_by', 'index'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 5],
});

export function recordSiteSearch({
  cohort,
  servedBy,
  index,
  hitCount,
  seconds,
}: {
  cohort: SearchEngine;
  servedBy: SearchEngine;
  index: string;
  hitCount: number;
  seconds: number;
}) {
  siteSearchQueriesCounter.inc({
    cohort,
    served_by: servedBy,
    index,
    hits: hitCount > 0 ? 'some' : 'none',
  });
  siteSearchDurationHistogram.observe({ cohort, served_by: servedBy, index }, seconds);
}
