import type { Counter, Gauge, Histogram } from 'prom-client';
import client from 'prom-client';
import { datapacketDbRead } from '~/server/db/datapacketDb';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
// request-bulkhead is a pure leaf module (no imports), so this edge cannot form a cycle.
import { bulkheadSnapshot } from '~/server/utils/request-bulkhead';

const PROM_PREFIX = 'civitai_app_';

// ---------------------------------------------------------------------------
// Cross-graph shared registry (for instrumentation-time metrics)
// ---------------------------------------------------------------------------
//
// WHY: Next.js compiles `instrumentation.ts` into a SEPARATE webpack bundle from
// the API-route/pages bundle, and `prom-client` is NOT in `serverExternalPackages`
// (next.config.mjs), so each bundle gets its own copy of the module — and thus its
// own `client.register` (the prom-client `globalRegistry`). A metric created and
// mutated from the instrumentation graph (e.g. the event-loop long-task detector's
// `setInterval`) lands in the instrumentation graph's registry, while `/metrics`
// (an API route) scrapes the request graph's registry. The two never meet, so the
// counter/histogram/gauge appear registered-but-never-incremented (or never
// exported) even though the emitting code runs. See the eventloop-longtask metrics
// bug (civitai PR #2451).
//
// FIX: pin ONE `Registry` on `globalThis` (the real V8 global, shared across all
// webpack bundles in the same Node process — the same mechanism the
// `global.pgGaugeInitialized` guards below already rely on). Any metric created in
// EITHER graph registers into this single object, and `/metrics` merges it into the
// scrape. This is required only for metrics emitted from the instrumentation graph;
// request-graph-only metrics already work because they emit + scrape in one graph.
declare global {
  // eslint-disable-next-line no-var
  var __civitaiInstrumentationRegistry: client.Registry | undefined;
}

export const instrumentationRegistry: client.Registry =
  globalThis.__civitaiInstrumentationRegistry ??
  (globalThis.__civitaiInstrumentationRegistry = new client.Registry());

/**
 * Get-or-create a metric in the cross-graph shared `instrumentationRegistry`,
 * idempotently. Use this for any metric created or mutated from the instrumentation
 * graph (`instrumentation.ts` subtree) so that `/metrics` — scraped from the request
 * graph — can actually see it.
 *
 * The metric is created via `factory` which MUST construct it with
 * `registers: [instrumentationRegistry]` (so it lands in the shared registry, not
 * the default per-graph one). Because both webpack graphs eval the same module-level
 * code against the SAME globalThis-pinned registry, the second graph (and HMR
 * re-evals) would otherwise throw "already registered" inside the constructor — so we
 * short-circuit to the existing instance BEFORE calling `factory`. Returns the single
 * shared instance either way.
 */
export function registerInstrumentationMetric<M extends client.Metric<string>>(
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

// External moderation deferred re-screen outcomes (CSAM pre-screen recovery).
// The inline external-moderation call (OpenAI omni-moderation) is fail-soft: when
// OpenAI is slow/down the prompt's CSAM pre-screen is silently skipped. Those skips
// are enqueued and re-screened async by the rescreen-skipped-prompt-moderation job.
// Exposed name: civitai_app_external_moderation_outcome_total. `outcome`:
//   skipped           — inline call failed → enqueued for deferred re-screen
//   rescreen_clean    — deferred re-screen returned not-flagged
//   rescreen_flagged  — deferred re-screen flagged → same consequence as inline
//   rescreen_requeued — re-screen threw again (OpenAI still down) → re-enqueued
//   rescreen_dropped  — re-screen kept failing past the attempt cap → dropped + logged
export const externalModerationOutcomeCounter = registerCounterWithLabels({
  name: 'external_moderation_outcome_total',
  help: 'External moderation deferred re-screen outcomes (inline-skip recovery)',
  labelNames: ['outcome'] as const,
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

// createCachedArray cluster-read FAIL-OPEN metrics (PR #2619). The fail-open degrades a
// rejected cluster Redis read to a direct origin (DB) fetch instead of a 500 — trading 500s
// for DB load. These make that trade observable:
//   - degraded_total      = times we entered the degraded path (the fail-open FIRE RATE; a
//                           proxy for a wedged cluster client, per cache).
//   - origin_fetch_total  = ids actually sent to lookupFn (the DEDUPED DB load, after per-id
//                           single-flight). Its rate is the real DB-row load a wedge induces;
//                           origin_fetch / (ids requested) shows the coalescing effectiveness.
// Healthy traffic never touches these (the path is reached only on a cluster-read reject).
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

// Cluster-client SELF-HEAL reconnect counter (FIX #1). Incremented once each time the
// inflight-leak watchdog forces a full cluster reconnect because inflight stayed pinned
// above the threshold for the sustained window. Healthy pods never touch this; a nonzero
// rate flags a pod that hit the binary-wedge state and was auto-recovered (vs needing a
// human rolling-restart). Pair with redis_commands_inflight on a dashboard to see the
// pin → reconnect → drain. No labels (per-pod attribution comes from the Prometheus `pod`
// label); cardinality is 1 series.
// `trigger` distinguishes the two watchdog paths: 'deadline' = the sawtooth-immune
// deadline-hit-rate trigger (the one that actually fires during a real fleet half-open wave —
// see cluster-selfheal.ts), 'inflight' = the legacy sustained-inflight breach. At the next prod
// wave, a rising deadline-labeled series is the confirmation that the fix worked. 2 series.
export const redisSelfHealReconnectCounter = registerCounterWithLabels({
  name: 'redis_selfheal_reconnect_total',
  help: 'Forced cluster-client reconnects by the inflight-leak self-heal watchdog',
  labelNames: ['trigger'] as const,
});

// Non-critical metric WRITE/LOCK fail-soft counter (FIX #3). Incremented when a
// metrics:lock setNX/expire or an increment hIncrBy hit the short fail-fast timeout (or a
// redis error) and the call site skipped the metric/lock so the user mutation could still
// succeed. `op` is a tiny fixed enum (populate-lock:*, increment:*). A sustained rate means
// engagement metrics are momentarily under-counting on a wedged pod — never a money/
// entitlement impact (these are analytics counters).
export const redisMetricWriteFailSoftCounter = registerCounterWithLabels({
  name: 'redis_metric_write_failsoft_total',
  help: 'Non-critical metric write/lock cluster commands that failed soft (timed out/errored, skipped)',
  labelNames: ['op'] as const,
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

// Redis client in-flight + duration instrumentation.
//
// WHY: api-primary 504 cascades root-cause to node-redis commands parking
// off-CPU in the command queue against a SILENT half-open connection (no
// RST/FIN). The event loop stays flat and every dependency server-metric is
// clean — the stall is entirely client-side and was uninstrumented. These two
// metrics make it visible: during a cascade `redis_commands_inflight` climbs
// toward the concurrency ceiling and `redis_command_duration_seconds` piles
// into the top (~30s) bucket, directly attributing the request hang to Redis
// (and confirming/refuting the socketTimeout fix on the next event).
//
// Cardinality is intentionally tiny: one label `client` ∈ cluster|sys. No
// per-key / per-command-name labels. Overhead per command is a gauge inc/dec
// plus one histogram observe of an already-captured timestamp delta — no
// per-command allocation beyond the closure the wrapper already creates.
export const redisCommandsInflight = registerGaugeWithLabels({
  name: 'redis_commands_inflight',
  help: 'In-flight node-redis commands by client (cluster vs sys); climbs toward the queue ceiling during a half-open stall',
  labelNames: ['client'] as const,
});

export const redisCommandDuration = registerHistogram({
  name: 'redis_command_duration_seconds',
  help: 'node-redis command wall-clock duration by client; the long tail (~30s bucket) is the half-open command-queue park',
  labelNames: ['client'] as const,
  // Up to 30s to capture the parked-command tail that maps onto the Traefik
  // 30s ceiling → 504. Lean bucket set keeps the series count low.
  buckets: [0.001, 0.005, 0.025, 0.1, 0.5, 1, 2, 5, 10, 30],
});

// The bridge to '~/server/redis/client' via globalThis.__civitaiRedisMetrics is
// published below, AFTER the sysredisSentinel* counters are declared (search for
// "__civitaiRedisMetrics ="). Placing it there lets us capture all four counter
// values directly instead of behind getters — a getter that fired during
// top-level eval (before the const declarations executed) would throw a
// ReferenceError that the no-op fallback at the call site (optional chaining)
// does NOT catch. No eager reader exists today; the bridge is consumed only
// from function bodies in redis/client.ts at command/connect time.

// Image feed metrics
export const imagesFeedWithoutIndexCounter = registerCounter({
  name: 'images_feed_without_index_total',
  help: 'Number of times getInfiniteImagesHandler resolves to the DB path (index cannot serve the query params)',
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

// App Blocks buzz attribution
// One row written per buzz purchase originating inside a block. Labels
// give us per-provider, per-scope, per-status dashboards without
// cross-contaminating sums. `status` values: 'pending'|'voided' at
// write time; future status changes go through separate counters.
export const blockBuzzAttributionWriteCounter = registerCounterWithLabels({
  name: 'block_buzz_attribution_total',
  help: 'Block buzz attribution rows written',
  labelNames: ['provider', 'scope', 'status'] as const,
});

// App Blocks buzz SPEND attribution (W3 flow A)
// One row written per block-initiated generation that spends the viewer's
// own Buzz balance and accrues an author bounty. `status` ∈
// 'pending'|'voided' at write time (voided = self-spend/internal-owner
// zero-share row); 'duplicate' marks an idempotent no-op (same workflow
// re-submitted). No provider/scope labels — spend has neither.
export const blockSpendAttributionWriteCounter = registerCounterWithLabels({
  name: 'block_spend_attribution_total',
  help: 'Block buzz spend attribution rows written',
  labelNames: ['status'] as const,
});

// App Blocks MEMBERSHIP / subscription attribution (W3 flow C)
// One row written per PAID invoice of a block-initiated membership
// purchase. `status` ∈ 'pending'|'voided' at write time (voided =
// self-purchase/internal-owner zero-share row); 'duplicate' marks an
// idempotent no-op (same invoice webhook retried); 'clawback' marks a
// negative carry-forward row written on refund/proration of a paid-out
// period. `billing_reason' tells subscription_create (initial) from
// subscription_cycle (renewal) so renewals-pay is observable.
export const blockSubscriptionAttributionWriteCounter = registerCounterWithLabels({
  name: 'block_subscription_attribution_total',
  help: 'Block membership/subscription attribution rows written',
  labelNames: ['provider', 'status', 'billing_reason'] as const,
});

// App Blocks KV datastore (W4-v0)
// `op` ∈ get|set|delete|list|getQuota; `outcome` ∈ ok|unauthorized|
// not_found|payload_too_large|quota_exceeded|error. Read-only counters
// keep the procedure-side instrumentation cheap; heavier histograms hang
// off a future per-app dashboard.
export const appStorageOpsCounter = registerCounterWithLabels({
  name: 'app_blocks_storage_ops_total',
  help: 'App Blocks KV datastore tRPC operations',
  labelNames: ['op', 'outcome'] as const,
});

// One quota-exceeded reject is interesting on its own (it means the
// publisher hit the 50MB ceiling). Track per-app_block_id so we can
// surface specific apps in alerts before they get bumped to v1.
export const appStorageQuotaExceededCounter = registerCounterWithLabels({
  name: 'app_blocks_storage_quota_exceeded_total',
  help: 'App Blocks KV writes rejected because the app quota would be exceeded',
  labelNames: ['app_block_id'] as const,
});

// Per-operation latency. Buckets sized for KV operations on a small CNPG
// cluster (everything should land < 50ms in the happy path; outliers
// beyond 250ms point at quota lookups blocked on a long write somewhere).
function registerHistogramWithLabels<T extends string>(opts: {
  name: string;
  help: string;
  labelNames: readonly T[];
  buckets: number[];
}) {
  try {
    return new client.Histogram({
      name: PROM_PREFIX + opts.name,
      help: opts.help,
      labelNames: opts.labelNames as unknown as string[],
      buckets: opts.buckets,
    });
  } catch {
    return client.register.getSingleMetric(PROM_PREFIX + opts.name) as client.Histogram<T>;
  }
}

export const appStorageLatencyHistogram = registerHistogramWithLabels({
  name: 'app_blocks_storage_latency_seconds',
  help: 'App Blocks KV procedure latency',
  labelNames: ['op'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// sysRedis Sentinel observability — Phase 4 cutover SRE-on-call uses these to
// distinguish a real failover from steady-state sentinel chatter. Cardinality:
// `type` is a small enum (master-change, +switch-master, etc.), `host` is bounded
// by the sentinel/master/replica pod count (~3-6), `deployment` is per-pod (same
// shape as Prometheus's own `pod` label).
//
// Override the PROM_PREFIX so the name maps to `civitai_sysredis_*` (matches the
// dashboard naming requested in the audit) rather than `civitai_app_*`.
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
  // HMR-safe registration (see registerCounterWithLabels above).
  try {
    return new client.Counter({ name: SYSREDIS_PREFIX + name, help, labelNames });
  } catch (e) {
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

// Bridge the redis metric handles to '~/server/redis/client' via globalThis,
// WITHOUT that module statically importing this one. redis/client.ts is
// client-bundle-reachable (`_app.tsx` → `system-cache.ts` → redis/client.ts) and
// prom-client eagerly requires `fs`/`cluster` at load (defaultMetrics + cluster
// aggregator), so a static `redis/client → prom/client` import edge breaks the
// pages-router client webpack build. This module only ever loads server-side
// (imported by trpc/api routes/instrumentation at startup), so publishing here is
// safe and is in place before any real redis command runs. instrumentCommands()
// and attachSysSentinelListeners read `globalThis.__civitaiRedisMetrics` at
// command/connect time.
//
// Placed AFTER all four counters declare so no getter indirection is needed
// (and no TDZ surface — a getter that fires during top-level eval would throw
// ReferenceError, which the no-op fallback at the call site does NOT catch).
(globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics = {
  redisCommandsInflight,
  redisCommandDuration,
  sysredisSentinelTopologyChangesCounter,
  sysredisSentinelClientErrorsCounter,
  redisSelfHealReconnectCounter,
  redisMetricWriteFailSoftCounter,
};

// pgPoolAcquireHistogram is registered in src/server/db/db-helpers.ts, not here.
// Defining it here would create a module-init cycle (prom/client.ts imports
// pgDb → db-helpers, which would import this histogram back), which webpack's
// CJS chunking can break with a TDZ error at runtime.

declare global {
  // eslint-disable-next-line no-var
  var pgGaugeInitialized: boolean;
  // eslint-disable-next-line no-var
  var heavyBulkheadGaugeInitialized: boolean;
}

// Heavy-route bulkhead observability (per pod). collect()-based so it reflects the
// live in-process state on each scrape with no per-request work. This is the signal
// for tuning HEAVY_REQUEST_CONCURRENCY: rejects climbing means the pod is shedding.
if (!global.heavyBulkheadGaugeInitialized) {
  new client.Gauge({
    name: PROM_PREFIX + 'heavy_bulkhead_active',
    help: 'In-flight heavy-route bulkhead slots per key (per pod)',
    labelNames: ['key'],
    collect() {
      for (const { key, active } of bulkheadSnapshot()) this.set({ key }, active);
    },
  });
  new client.Gauge({
    name: PROM_PREFIX + 'heavy_bulkhead_rejects',
    help: 'Cumulative heavy-route bulkhead fast-fail rejects per key (per pod); monotonic, use rate()',
    labelNames: ['key'],
    collect() {
      for (const { key, rejects } of bulkheadSnapshot()) this.set({ key }, rejects);
    },
  });
  global.heavyBulkheadGaugeInitialized = true;
}

if (!global.pgGaugeInitialized) {
  new client.Gauge({
    name: 'node_postgres_read_total_count',
    help: 'node postgres read total count',
    collect() {
      this.set(pgDbRead.totalCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_read_idle_count',
    help: 'node postgres read idle count',
    collect() {
      this.set(pgDbRead.idleCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_read_waiting_count',
    help: 'node postgres read waiting count',
    collect() {
      this.set(pgDbRead.waitingCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_write_total_count',
    help: 'node postgres write total count',
    collect() {
      this.set(pgDbWrite.totalCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_write_idle_count',
    help: 'node postgres write idle count',
    collect() {
      this.set(pgDbWrite.idleCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_write_waiting_count',
    help: 'node postgres write waiting count',
    collect() {
      this.set(pgDbWrite.waitingCount);
    },
  });

  // Labeled pool metrics for all pools
  new client.Gauge({
    name: 'node_postgres_pool_total_count',
    help: 'Total connections in pg pool',
    labelNames: ['pool'],
    collect() {
      this.set({ pool: 'read' }, pgDbRead?.totalCount ?? 0);
      this.set({ pool: 'write' }, pgDbWrite?.totalCount ?? 0);
      this.set({ pool: 'read_long' }, pgDbReadLong?.totalCount ?? 0);
      this.set({ pool: 'notif_read' }, notifDbRead?.totalCount ?? 0);
      this.set({ pool: 'notif_write' }, notifDbWrite?.totalCount ?? 0);
      this.set({ pool: 'datapacket_read' }, datapacketDbRead?.totalCount ?? 0);
    },
  });
  new client.Gauge({
    name: 'node_postgres_pool_idle_count',
    help: 'Idle connections in pg pool',
    labelNames: ['pool'],
    collect() {
      this.set({ pool: 'read' }, pgDbRead?.idleCount ?? 0);
      this.set({ pool: 'write' }, pgDbWrite?.idleCount ?? 0);
      this.set({ pool: 'read_long' }, pgDbReadLong?.idleCount ?? 0);
      this.set({ pool: 'notif_read' }, notifDbRead?.idleCount ?? 0);
      this.set({ pool: 'notif_write' }, notifDbWrite?.idleCount ?? 0);
      this.set({ pool: 'datapacket_read' }, datapacketDbRead?.idleCount ?? 0);
    },
  });
  new client.Gauge({
    name: 'node_postgres_pool_waiting_count',
    help: 'Waiting connections in pg pool',
    labelNames: ['pool'],
    collect() {
      this.set({ pool: 'read' }, pgDbRead?.waitingCount ?? 0);
      this.set({ pool: 'write' }, pgDbWrite?.waitingCount ?? 0);
      this.set({ pool: 'read_long' }, pgDbReadLong?.waitingCount ?? 0);
      this.set({ pool: 'notif_read' }, notifDbRead?.waitingCount ?? 0);
      this.set({ pool: 'notif_write' }, notifDbWrite?.waitingCount ?? 0);
      this.set({ pool: 'datapacket_read' }, datapacketDbRead?.waitingCount ?? 0);
    },
  });

  global.pgGaugeInitialized = true;
}
