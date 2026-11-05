import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const searchDuration = new Histogram({
  name: 'search_request_duration_seconds',
  help: 'Search request duration by index, query kind and outcome.',
  labelNames: ['index', 'kind', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const queryVectorCache = new Counter({
  name: 'search_query_vector_cache_total',
  help: 'Query-embedding cache lookups by result (hit, miss).',
  labelNames: ['result'],
  registers: [registry],
});
