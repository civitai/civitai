import type { Counter } from 'prom-client';
import client from 'prom-client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';

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

// Model feed metrics
export const modelsFeedWithoutIndexCounter = registerCounter({
  name: 'models_feed_without_index_total',
  help: 'Number of times getModelsInfiniteHandler is called with useIndex=false or undefined',
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

// User update tracking metrics
export const userUpdateCounter = registerCounterWithLabels({
  name: 'user_update_total',
  help: 'Total number of user table updates by location',
  labelNames: ['location'] as const,
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

  global.pgGaugeInitialized = true;
}
