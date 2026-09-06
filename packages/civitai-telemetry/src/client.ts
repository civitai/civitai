import type {
  Counter,
  Gauge,
  Histogram,
  HistogramConfiguration,
  Metric,
  Registry,
} from 'prom-client';
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
//
// An earlier version of this comment cited "the pgGaugeInitialized guards" as the precedent for
// pinning on globalThis. Those guards did pin a FLAG on globalThis — but the registry they guarded
// was still per-graph, so the flag let the first graph claim the registration and silently deny it
// to the graph that is actually scraped. Every metric behind them emitted 0 series in production
// for months. A globalThis flag is only safe when what it guards is ALSO globalThis-shared;
// registerInstrumentationMetric below is safe because it dedupes against the shared registry
// itself, rather than against a flag standing in for it.
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

export function registerGauge({ name, help }: { name: string; help: string }) {
  // Do this to deal with HMR in nextjs
  try {
    return new client.Gauge({ name: PROM_PREFIX + name, help });
  } catch (e) {
    return client.register.getSingleMetric(PROM_PREFIX + name) as Gauge<string>;
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
    // Only set labelNames/buckets when provided. Passing `undefined` for either
    // overrides prom-client's own defaults (labelNames -> [], buckets -> the
    // default set) via Object.assign, and an undefined labelNames makes the
    // Histogram constructor throw AFTER it has already self-registered — leaving
    // a bucketless zombie in the registry that the catch below then hands back,
    // so a later .observe() dies on `undefined.length` in findBound.
    const config: HistogramConfiguration<T> = { name: fullName, help };
    if (labelNames) config.labelNames = [...labelNames];
    if (buckets) config.buckets = [...buckets];
    return new client.Histogram(config);
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
export const rewardConfigReadFailedCounter = registerCounter({
  name: 'reward_config_read_failed_total',
  help: 'Runtime reward-config read failed; rewards ran on the last good config',
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
// layout is trimmed for cardinality (see the buckets note below) while keeping
// resolution around typical p95/p99.
//
// ⚠️ HIGH CARDINALITY: `path` is a fixed enum of ~870 procedure names (NOT ~93 —
// that's the router count), so this emits ~870 x (buckets+sum+count) series PER
// POD. It is gated OPT-IN behind TRPC_PROCEDURE_METRICS (see trpc.ts) so only the
// pools we point it at (api-primary, api-heavy) pay the cost. Buckets kept lean.
export const trpcProcedureDuration = registerHistogram({
  name: 'trpc_procedure_duration_seconds',
  help: 'tRPC procedure wall-clock duration (full chain + resolver) by path',
  labelNames: ['path'] as const,
  // Trimmed 7→6 explicit boundaries (le 8→7 incl. +Inf, ~12% fewer _bucket
  // series) to cut Prometheus cardinality on this high-`path` histogram while
  // keeping boundaries near typical p95/p99. Dropped only the 50ms floor; the
  // 30s tail boundary is retained so _bucket-based p99 can still resolve the
  // 10–30s range (the parked-handler / slow-procedure diagnostic band).
  buckets: [0.1, 0.5, 1, 2.5, 10, 30],
});

// Web-client READ-capability saturation for the superjson → devalue serializer
// migration. Incremented per web tRPC procedure, bucketed by whether the request's
// reported `x-client-version` belongs to a build that can decode the union
// serializer (Phase-1-capable). LOW cardinality by construction: a single boolean
// label (`phase1_capable` = 'true' | 'false') — NOT the raw version string. The
// Phase-2 write-flip go/no-go reads the saturation ratio:
//   rate(...{phase1_capable="true"}) / rate(...) — the fraction of live web traffic
//   that can safely decode a devalue response.
export const trpcClientReadCapabilityRequests = registerCounterWithLabels({
  name: 'trpc_client_read_capability_requests_total',
  help: 'Web tRPC procedures bucketed by client union-decode (Phase-1) capability',
  labelNames: ['phase1_capable'] as const,
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

// Duration of the brotli codec on the opt-in compressed `redis.packed` paths, by `op`
// (compress | decompress) and `cache_name`.
//
// 🔴 WHAT A SAMPLE CONTAINS, because the name says "codec" and the number is wider than that. The
// clock starts before the promisified call is enqueued and stops at the `await` CONTINUATION on the
// JS thread, so a sample is threadpool queue wait + codec work + whatever event-loop delay sits
// between the completion landing and the continuation running. Measured: a 50 ms main-thread block
// held while a decompress is in flight yields a 50.79 ms sample — event-loop delay is absorbed ~1:1.
// And the floor is dispatch, not codec: a 1-byte payload (no real codec work) round-trips in ~11 µs
// p50 on one machine and ~22 µs on another, against a typical ~25-36 µs decompress — i.e. roughly
// half or more of a typical sample is the hand-off, not brotli. Read the low buckets accordingly.
//
// WHY A SEPARATE HISTOGRAM. Two existing signals both LOOK like they cover this and neither does:
//   - CPU profiles: the codec is `promisify(zlib.brotli*)`, i.e. it runs on the libuv threadpool.
//     Threadpool work carries no JS stack, so no `brotli*` frame is ever sampled — a profile search
//     returns zero, which reads as "the codec is free" rather than "the profiler cannot see it".
//   - redis_command_duration_seconds: that observation closes when the redis round trip closes,
//     while compress happens before the write and decompress after the read. Worse, it moves the
//     WRONG WAY — a compressed payload is smaller on the wire, so turning compression on makes that
//     histogram improve while adding codec cost it structurally cannot observe.
// So this is the only signal that can answer "what does compression cost us".
//
// `cache_name` is the cache PREFIX (e.g. `packed:caches:image-meta`). It is chosen so cardinality
// stays bounded by the small set of caches that opt into `compress`; callers with no bounded name
// report 'unknown'.
//
// HOW FAR THE JOIN TO CACHE TRAFFIC GOES — it holds for ONE of the two consumers, so do not plan a
// dashboard on it without checking which:
//   - createCachedArray / createCachedObject DO join: the builder passes its `key` as this label
//     AND passes the same `key` as `cache_name` to cacheHitCounter/cacheMissCounter, so the two
//     label values are equal by construction.
//   - fetchThroughCache does NOT join: it emits no hit/miss counters at all, so there is no
//     cache-traffic series carrying this `cache_name` to join against. (The nearest counter a
//     reader might reach for — the tensor-metadata in-process LRU — labels itself
//     'tensor-metadata-full', a different value naming a different cache.) The label still earns
//     its place there by separating one cache's codec cost from another's; it is simply not a join
//     key today.
//
// BUCKETS — seconds, and the floor has to be tens of MICROseconds. "Sub-ms for a typical record"
// is true and was still the wrong floor: the two live compress-aware caches sit at opposite ends.
// imageMetaCache values are ~0.5-4 KB and decompress in ~0.026 ms, so against a 0.0005 first edge
// the overwhelming majority of all samples land in the first bucket and histogram_quantile is
// pinned to that edge no matter what the codec does. tensor-metadata's ~335 KB blob is the
// tens-of-ms tail. The edge set below spans both, and the four smallest exist so the common case
// is resolvable at all rather than reported as "somewhere under half a millisecond".
// ⚠️ Changing these edges resets every series' history — settle them before this ships.
//
// Exported so the resolution invariant can be checked mechanically rather than by eye. The guard
// in ./__tests__/packed-codec-buckets.test.ts does NOT read this constant for its verdict — it
// observes a sample and reads the `le` set back off the REGISTERED histogram, so editing `buckets:`
// below without editing this list (or the reverse) fails. It pins three properties: the measured
// common case is not swallowed by the first bucket, no adjacent pair of edges is more than 4x
// apart (so no single bucket can span the resolvable range), and the large-blob tail is covered.
export const PACKED_CODEC_DURATION_BUCKETS = [
  0.00002, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
  0.5, 1,
] as const;

export const packedCodecDuration = registerHistogram({
  name: 'packed_codec_duration_seconds',
  help: 'Brotli codec duration for compressed redis.packed values, by op and cache_name. Wall clock as the CALLER sees it, NOT CPU time: the clock stops at the await continuation on the JS thread, so a sample is libuv threadpool QUEUE WAIT + codec work + EVENT-LOOP DELAY before the completion is delivered (a blocked JS thread inflates it ~1:1 — a 50ms block measured 50.79ms). The threadpool round-trip floor is ~10-25us even for a byte-sized payload, so the lowest buckets are dispatch overhead rather than codec time. A rise means the codec PATH got slower; it does NOT on its own mean brotli got more expensive. Invisible to CPU profiles (the codec runs off the JS stack) and not covered by redis_command_duration_seconds, which stops at the round trip.',
  labelNames: ['op', 'cache_name'] as const,
  buckets: [...PACKED_CODEC_DURATION_BUCKETS],
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

// The self-heal watchdog's OWN observation of the wedge: the in-process count of cluster command
// SLOW-SETTLES in its sliding window (the deadline-hit trigger's input), sampled + published each
// watchdog tick. This is DISTINCT from redis_command_duration_seconds — it is exactly what the
// watchdog evaluates against REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_THRESHOLD, so a rising series that
// crosses the threshold is the leading indicator of an imminent self-heal reconnect. Added after
// the 2026-07-06 fleet wedge, where the watchdog's own signal was invisible and the trigger 0-fired.
export const redisSelfHealDeadlineHitsWindow = registerGaugeWithLabels({
  name: 'redis_selfheal_deadline_hits_window',
  help: "The self-heal watchdog's in-process cluster slow-settle count over its sliding window, by client; the deadline-hit trigger fires when this crosses the threshold",
  labelNames: ['client'] as const,
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

// Image ingestion / scan pipeline. The image-ingestion path (submit → scanner →
// webhook write-back → cron drain) previously had ZERO Prometheus coverage; these
// give per-lane submission volume, webhook-outcome split, cron throughput, and (via
// collect()-based gauges in src/server/prom/client.ts) the working-state backlog.
export const imageScanWebhookCounter = registerCounterWithLabels({
  name: 'image_scan_webhook_total',
  help: 'Image scan-result webhook callbacks by outcome',
  labelNames: ['result'] as const,
});

export const imageScanSubmittedCounter = registerCounterWithLabels({
  name: 'image_scan_submitted_total',
  help: 'ingestImage() scan submissions by lane (new|legacy) and result (success|failed)',
  labelNames: ['lane', 'result'] as const,
});

export const imageIngestCronCounter = registerCounterWithLabels({
  name: 'image_ingest_cron_total',
  help: 'ingest-images cron per-bucket image counts (sent lanes, waitingForRetry, staleRemoved)',
  labelNames: ['bucket'] as const,
});

export const imageIngestCronQueueDepth = registerGauge({
  name: 'image_ingest_cron_queue_depth',
  help: 'ImageScan JobQueue depth read by the ingest-images cron on its most recent run',
});

// Fleet-wide cron job health (createJob in src/server/jobs/job.ts). Makes a
// dead/erroring cron — e.g. ingest-images — visible: job_errors_total spikes and
// the duration histogram flatlines when a job stops running.
export const jobDurationHistogram = registerHistogram({
  name: 'job_duration_seconds',
  help: 'Cron job wall-clock run duration by job name',
  labelNames: ['job'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
});
export const jobErrorsCounter = registerCounterWithLabels({
  name: 'job_errors_total',
  help: 'Cron job runs that threw, by job name',
  labelNames: ['job'] as const,
});

// Job names already seeded in THIS module instance. `Histogram.zero()` overwrites the
// series rather than merging into it, so a second call for a name that has since been
// observed would silently wipe that job's buckets. Seeding is once-per-name by
// construction today (createJob runs at each job module's top level), but the failure
// mode is invisible in the data, so it is closed here rather than assumed away.
const seededJobs = new Set<string>();

/**
 * Seed both cron metrics' series for `job` at zero.
 *
 * 🔴 WHY THIS EXISTS: a prom-client metric declared with `labelNames` emits NO series at
 * all for a label value it has never observed. So before a job's first completed run —
 * and, for the error counter, before its first FAILURE — neither series appears in the
 * /metrics response, and the two metrics above cannot answer the question they were added
 * to answer. Their own help text promises that a dead cron shows up as a flatlined
 * duration histogram next to a live `job_errors_total`; without seeding, a cron that is
 * dead, a cron that has not run since this pod started, and a cron that was deleted from
 * the codebase are all the SAME observation — an absent series. `absent()` and `rate()`
 * alerts written against them are unreliable for the same reason, and a healthy zero is
 * indistinguishable from an instrument that was never wired up.
 *
 * Seeding at job-construction time makes every `createJob` job an observable zero from the
 * moment its module is loaded, so absence once again means "no such job".
 *
 * This mirrors the seeding the /metrics route already does for its own counters, and the
 * same reasoning is written out at each of those call sites.
 */
export function seedJobMetrics(job: string) {
  if (seededJobs.has(job)) return;
  seededJobs.add(job);
  jobDurationHistogram.zero({ job });
  jobErrorsCounter.inc({ job }, 0);
}

// NOTE: the DB pool-depth gauges live in the app (src/server/prom/client.ts) — they
// compose the db pools + these prom helpers, which is app-level glue, not infra.
