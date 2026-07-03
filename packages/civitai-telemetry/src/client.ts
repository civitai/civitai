import type { Counter, Gauge, Histogram, Metric, Registry } from 'prom-client';
import client from 'prom-client';

export const PROM_PREFIX = 'civitai_app_';

// ---------------------------------------------------------------------------
// Cross-graph shared registry (for instrumentation-time metrics)
// ---------------------------------------------------------------------------
// Next.js compiles instrumentation.ts into a SEPARATE webpack bundle from the API-route/pages
// bundle, and prom-client is NOT in serverExternalPackages, so each bundle gets its own
// `client.register` (globalRegistry). A metric created/mutated from the instrumentation graph lands
// in that graph's registry, while /metrics (an API route) scrapes the request graph's registry — so
// the two never meet (the metric appears registered-but-never-exported). Fix: pin ONE Registry on
// globalThis (the real V8 global, shared across all webpack bundles in one Node process — the same
// mechanism the pgGaugeInitialized guards rely on). Any metric created in either graph registers
// here, and /metrics merges it into the scrape. (See the eventloop-longtask metrics bug, PR #2451.)
declare global {
  // eslint-disable-next-line no-var
  var __civitaiInstrumentationRegistry: Registry | undefined;
}

export const instrumentationRegistry: Registry =
  globalThis.__civitaiInstrumentationRegistry ??
  (globalThis.__civitaiInstrumentationRegistry = new client.Registry());

/**
 * Get-or-create a metric in the cross-graph shared `instrumentationRegistry`, idempotently. The
 * metric is created via `factory`, which MUST construct it with `registers: [instrumentationRegistry]`
 * so it lands in the shared registry. Because both webpack graphs eval this module-level code against
 * the SAME globalThis-pinned registry, the second graph (and HMR re-evals) would otherwise throw
 * "already registered" inside the constructor — so we short-circuit to the existing instance first.
 */
export function registerInstrumentationMetric<M extends Metric<string>>(
  name: string,
  factory: () => M
): M {
  const existing = instrumentationRegistry.getSingleMetric(name);
  if (existing) return existing as unknown as M;
  return factory();
}

export function registerCounter({ name, help }: { name: string; help: string }) {
  // Do this to deal with HMR in nextjs
  try {
    return new client.Counter({ name: PROM_PREFIX + name, help });
  } catch (e) {
    return client.register.getSingleMetric(PROM_PREFIX + name) as Counter<string>;
  }
}

export function registerCounterWithLabels<T extends string>({
  name,
  help,
  labelNames,
}: {
  name: string;
  help: string;
  labelNames: readonly T[];
}) {
  // Do this to deal with HMR in nextjs
  try {
    return new client.Counter({ name: PROM_PREFIX + name, help, labelNames });
  } catch (e) {
    return client.register.getSingleMetric(PROM_PREFIX + name) as Counter<T>;
  }
}

export function registerGaugeWithLabels<T extends string>({
  name,
  help,
  labelNames,
}: {
  name: string;
  help: string;
  labelNames: readonly T[];
}) {
  // Do this to deal with HMR in nextjs
  try {
    return new client.Gauge({ name: PROM_PREFIX + name, help, labelNames });
  } catch (e) {
    return client.register.getSingleMetric(PROM_PREFIX + name) as Gauge<T>;
  }
}

export function registerHistogram<T extends string = string>({
  name,
  help,
  labelNames,
  buckets,
  prefix = PROM_PREFIX,
}: {
  name: string;
  help: string;
  labelNames?: readonly T[];
  buckets?: readonly number[];
  prefix?: string;
}) {
  // Do this to deal with HMR in nextjs
  const fullName = prefix + name;
  try {
    return new client.Histogram({
      name: fullName,
      help,
      labelNames: labelNames ? [...labelNames] : undefined,
      buckets: buckets ? [...buckets] : undefined,
    });
  } catch (e) {
    return client.register.getSingleMetric(fullName) as Histogram<T>;
  }
}

// Auth counters
export const missingSignedAtCounter = registerCounter({
  name: 'missing_signed_at_total',
  help: 'Missing Signed At',
});

// Account counters
export const newUserCounter = registerCounter({
  name: 'new_user_total',
  help: 'New user created',
});
export const loginCounter = registerCounter({
  name: 'login_total',
  help: 'User logged in',
});

// Onboarding counters
export const onboardingCompletedCounter = registerCounter({
  name: 'onboarding_completed_total',
  help: 'User completed onboarding',
});
export const onboardingErrorCounter = registerCounter({
  name: 'onboarding_error_total',
  help: 'User onboarding error',
});

// Content counters
export const leakingContentCounter = registerCounter({
  name: 'leaking_content_total',
  help: 'Inappropriate content that was reported in safe feeds',
});

// Vault counters
export const vaultItemProcessedCounter = registerCounter({
  name: 'vault_item_processed_total',
  help: 'Vault item processed',
});
export const vaultItemFailedCounter = registerCounter({
  name: 'vault_item_failed_total',
  help: 'Vault item failed',
});

// Reward counters
export const rewardGivenCounter = registerCounter({
  name: 'reward_given_total',
  help: 'Reward given',
});
export const rewardFailedCounter = registerCounter({
  name: 'reward_failed_total',
  help: 'Reward failed',
});

export const clavataCounter = registerCounter({
  name: 'clavata_req_total',
  help: 'Clavata requests',
});

// Cache metrics
export const cacheHitCounter = registerCounterWithLabels({
  name: 'cache_hit_total',
  help: 'Cache hits by cache name and type',
  labelNames: ['cache_name', 'cache_type'] as const,
});

export const cacheMissCounter = registerCounterWithLabels({
  name: 'cache_miss_total',
  help: 'Cache misses by cache name and type',
  labelNames: ['cache_name', 'cache_type'] as const,
});

export const cacheRevalidateCounter = registerCounterWithLabels({
  name: 'cache_revalidate_total',
  help: 'Cache revalidations (stale-while-revalidate) by cache name and type',
  labelNames: ['cache_name', 'cache_type'] as const,
});

// tRPC per-procedure latency — wall-clock duration of the full middleware chain +
// resolver, labeled by procedure path. Used to rank heavy-pool isolation
// candidates by P99 x rate (the criterion behind the image-feed cutover). Bucket
// layout (to 30s) keeps the long tail visible like images_search.
//
// ⚠️ HIGH CARDINALITY: `path` is a fixed enum of ~870 procedure names (NOT ~93 —
// that's the router count), so this emits ~870 x (buckets+sum+count) series PER
// POD. It is gated OPT-IN behind TRPC_PROCEDURE_METRICS (see trpc.ts) so only the
// pools we point it at (api-primary, api-heavy) pay the cost. Buckets kept lean.
export const trpcProcedureDuration = registerHistogram({
  name: 'trpc_procedure_duration_seconds',
  help: 'tRPC procedure wall-clock duration (full chain + resolver) by path',
  labelNames: ['path'] as const,
  buckets: [0.05, 0.25, 1, 2, 5, 10, 30],
});

// Image feed metrics
export const imagesFeedWithoutIndexCounter = registerCounter({
  name: 'images_feed_without_index_total',
  help: 'Number of times getInfiniteImagesHandler is called with useIndex=false or undefined',
});

// Creator compensation metrics
export const creatorCompCreatorsPaidCounter = registerCounterWithLabels({
  name: 'creator_comp_creators_paid_total',
  help: 'Total number of creators who received compensation',
  labelNames: ['account_type'] as const,
});

export const creatorCompAmountPaidCounter = registerCounterWithLabels({
  name: 'creator_comp_amount_paid_total',
  help: 'Total buzz amount paid to creators',
  labelNames: ['account_type'] as const,
});

// License fee payout metrics
export const licenseFeeCreatorsPaidCounter = registerCounterWithLabels({
  name: 'license_fee_creators_paid_total',
  help: 'Total number of creators who received license fee payouts',
  labelNames: ['account_type'] as const,
});

export const licenseFeeAmountPaidCounter = registerCounterWithLabels({
  name: 'license_fee_amount_paid_total',
  help: 'Total amount paid to creators for license fees',
  labelNames: ['account_type'] as const,
});

// User update tracking metrics
export const userUpdateCounter = registerCounterWithLabels({
  name: 'user_update_total',
  help: 'Total number of user table updates by location',
  labelNames: ['location'] as const,
});

// CDC replication lag fallback metrics
export const dbReadFallbackCounter = registerCounterWithLabels({
  name: 'dbread_fallback_total',
  help: 'Number of times a dbRead query fell back to dbWrite due to CDC replication lag',
  labelNames: ['entity', 'caller'] as const,
});

// App Blocks buzz attribution — one row per buzz purchase originating inside a block.
export const blockBuzzAttributionWriteCounter = registerCounterWithLabels({
  name: 'block_buzz_attribution_total',
  help: 'Block buzz attribution rows written',
  labelNames: ['provider', 'scope', 'status'] as const,
});

// App Blocks buzz-SPEND attribution (one row per block-initiated spend).
export const blockSpendAttributionWriteCounter = registerCounterWithLabels({
  name: 'block_spend_attribution_total',
  help: 'Block buzz spend attribution rows written',
  labelNames: ['status'] as const,
});

// App Blocks MEMBERSHIP / subscription attribution (one row per paid invoice of a
// block-initiated membership purchase).
export const blockSubscriptionAttributionWriteCounter = registerCounterWithLabels({
  name: 'block_subscription_attribution_total',
  help: 'Block membership/subscription attribution rows written',
  labelNames: ['provider', 'status', 'billing_reason'] as const,
});

// createCachedArray cluster-read fail-open (PR #2611): degraded-fetch + ids sent to origin, by cache name.
export const cacheFailOpenDegradedCounter = registerCounterWithLabels({
  name: 'cache_failopen_degraded_total',
  help: 'createCachedArray cluster-read fail-open: degraded-fetch calls by cache name',
  labelNames: ['cache_name'] as const,
});
export const cacheFailOpenOriginFetchCounter = registerCounterWithLabels({
  name: 'cache_failopen_origin_fetch_total',
  help: 'createCachedArray fail-open: ids sent to origin (lookupFn) by cache name — deduped DB load',
  labelNames: ['cache_name'] as const,
});

// ClickHouse TRANSPORT-error fail-soft counter. Incremented each time a path swallows a TRANSIENT
// ClickHouse connection/transport failure (socket hang up / Code 279 / Code 210 — see
// isClickHouseConnectionError) instead of 500-ing the request. The `path` label names where it
// happened. A query/schema error (UNKNOWN_TABLE etc.) is NEVER counted here — it still throws. A
// SUSTAINED nonzero rate is the alert signal that ClickHouse Cloud is in a real outage that fail-soft
// is now masking.
export const clickhouseFailSoftCounter = registerCounterWithLabels({
  name: 'civitai_app_clickhouse_failsoft_total',
  help: 'Transient ClickHouse transport errors swallowed (failed soft) instead of 500-ing, by path',
  labelNames: ['path'] as const,
});

// Redis per-command instrumentation — read by @civitai/redis via the globalThis bridge the app's
// prom shim publishes (see src/server/prom/client.ts). inflight gauge + duration histogram.
export const redisCommandsInflight = registerGaugeWithLabels({
  name: 'redis_commands_inflight',
  help: 'In-flight node-redis commands by client (cluster vs sys); climbs toward the queue ceiling during a half-open stall',
  labelNames: ['client'] as const,
});
export const redisCommandDuration = registerHistogram({
  name: 'redis_command_duration_seconds',
  help: 'node-redis command wall-clock duration by client; the long tail (~30s bucket) is the half-open command-queue park',
  labelNames: ['client'] as const,
  // Up to 30s to capture the parked-command tail that maps onto the Traefik 30s ceiling → 504.
  buckets: [0.001, 0.005, 0.025, 0.1, 0.5, 1, 2, 5, 10, 30],
});

// SELF-HEAL reconnect counter. Incremented once each time an inflight-leak self-heal watchdog forces
// a full client reconnect. Healthy pods never touch this; a nonzero rate flags a pod that hit the
// binary-wedge state and was auto-recovered (vs needing a human rolling-restart). `client`
// distinguishes which node-redis client healed: 'cluster' = the cache cluster client, 'sys' = the
// sysRedis Sentinel client (incident 2026-07-03). `trigger` distinguishes the watchdog path:
// 'deadline' = the sawtooth-immune deadline-hit-rate trigger (cluster only), 'inflight' = the
// sustained-inflight breach (both clients). (See @civitai/redis cluster-selfheal / sys-inflight.)
export const redisSelfHealReconnectCounter = registerCounterWithLabels({
  name: 'redis_selfheal_reconnect_total',
  help: 'Forced node-redis client reconnects by the inflight-leak self-heal watchdog, by client (cluster|sys) and trigger',
  labelNames: ['trigger', 'client'] as const,
});

// Cluster ROUTING retry-after-rediscover counter (the topology-churn 500 wave). Incremented when a cluster
// `_execute` hit a TRANSIENT pre-dispatch routing throw and the guard retried after a rediscover. `result`
// ∈ recovered|exhausted: a rising `recovered` series during a rolling update / failover confirms the fix
// converted a fleet-wide 500 wave into a transparent retry; `exhausted` means the slot map stayed
// inconsistent past the bounded retries and the original error re-threw. (See @civitai/redis cluster-routing-retry.)
export const redisRoutingRetryCounter = registerCounterWithLabels({
  name: 'redis_routing_retry_total',
  help: 'Cluster commands that hit a transient routing throw and were retried after a rediscover (recovered) or exhausted retries (exhausted, original error re-thrown)',
  labelNames: ['result'] as const,
});

// sysRedis Sentinel observability. Uses the `civitai_sysredis_*` metric prefix (NOT civitai_app_*)
// to match the dashboard naming, so it needs its own registrar.
const SYSREDIS_PREFIX = 'civitai_sysredis_';
function registerSysredisCounter<T extends string>({
  name,
  help,
  labelNames,
}: {
  name: string;
  help: string;
  labelNames: readonly T[];
}) {
  // HMR-safe registration (see registerCounterWithLabels).
  try {
    return new client.Counter({ name: SYSREDIS_PREFIX + name, help, labelNames });
  } catch {
    return client.register.getSingleMetric(SYSREDIS_PREFIX + name) as Counter<T>;
  }
}

export const sysredisSentinelTopologyChangesCounter = registerSysredisCounter({
  name: 'sentinel_topology_changes_total',
  help: 'sysRedis sentinel topology-change events (failover, sentinel-set change, etc.)',
  labelNames: ['type', 'host', 'deployment'] as const,
});
export const sysredisSentinelClientErrorsCounter = registerSysredisCounter({
  name: 'sentinel_client_errors_total',
  help: 'sysRedis sentinel sub-client errors (per-pod TCP/protocol errors against masters/replicas)',
  labelNames: ['type', 'host', 'deployment'] as const,
});

// App Blocks KV datastore (op ∈ get|set|delete|list|getQuota; outcome ∈ ok|unauthorized|…).
export const appStorageOpsCounter = registerCounterWithLabels({
  name: 'app_blocks_storage_ops_total',
  help: 'App Blocks KV datastore tRPC operations',
  labelNames: ['op', 'outcome'] as const,
});

export const appStorageQuotaExceededCounter = registerCounterWithLabels({
  name: 'app_blocks_storage_quota_exceeded_total',
  help: 'App Blocks KV writes rejected because the app quota would be exceeded',
  labelNames: ['app_block_id'] as const,
});

export const appStorageLatencyHistogram = registerHistogram({
  name: 'app_blocks_storage_latency_seconds',
  help: 'App Blocks KV procedure latency',
  labelNames: ['op'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// NOTE: the DB pool-depth gauges live in the app (src/server/prom/client.ts) — they
// compose the db pools + these prom helpers, which is app-level glue, not infra.
