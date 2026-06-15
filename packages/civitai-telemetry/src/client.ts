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
