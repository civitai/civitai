// Counters for the cluster-cache fast-fail paths (`~/server/redis/cluster-cache-guard`, the
// replication-lag check, and fetchThroughCache's serve-stale). Imported from
// `@civitai/telemetry/client` directly, like `model-moderation.metrics.ts`, so the guard does not pull
// `~/server/prom/client`'s pool gauges into every module that reads the cache. Every label value is a
// literal chosen at the call site (never a key or an id), so cardinality is bounded by the code.
import { registerCounterWithLabels } from '@civitai/telemetry/client';

export const clusterCacheFailOpenCounter = registerCounterWithLabels({
  name: 'cluster_cache_guard_failopen_total',
  help: 'Cluster-cache calls that failed open under the fast-fail guard, by call site, reason (timeout|error|breaker-open) and kind (read|write)',
  labelNames: ['fn', 'reason', 'kind'] as const,
});

export const clusterCacheBreakerTransitionCounter = registerCounterWithLabels({
  name: 'cluster_cache_breaker_transitions_total',
  help: 'Cluster-cache circuit breaker state transitions, by the state entered',
  labelNames: ['to'] as const,
});

export const replicationLagCheckFailOpenCounter = registerCounterWithLabels({
  name: 'replication_lag_check_failopen_total',
  help: 'Replication-lag checks whose flag-store read failed or timed out and routed to the replica',
  labelNames: ['reason'] as const,
});

export const fetchThroughCacheStaleServedCounter = registerCounterWithLabels({
  name: 'fetch_through_cache_stale_served_total',
  help: 'fetchThroughCache origin errors answered with the stale cached entry, by cache name',
  labelNames: ['cache_name'] as const,
});
