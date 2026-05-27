import type { Counter } from 'prom-client';
import client from 'prom-client';
import { datapacketDbRead } from '~/server/db/datapacketDb';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';

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

declare global {
  // eslint-disable-next-line no-var
  var pgGaugeInitialized: boolean;
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
