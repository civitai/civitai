import type { Counter, Gauge, Histogram } from 'prom-client';
import client from 'prom-client';
import { datapacketDbRead } from '~/server/db/datapacketDb';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
// request-bulkhead is a pure leaf module (no imports), so this edge cannot form a cycle.
import { bulkheadSnapshot } from '~/server/utils/request-bulkhead';

const PROM_PREFIX = 'civitai_app_';
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
