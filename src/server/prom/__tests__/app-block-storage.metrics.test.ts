import client from 'prom-client';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedAppBlockStorageMetrics } from '../app-block-storage.metrics';

/**
 * Zero-seeding of the four App Blocks KV storage metrics, against the REAL prom-client default
 * registry — `@civitai/telemetry/client` is not stubbed by `src/__tests__/setup.ts`, which
 * replaces only `~/server/prom/client`. Nothing here may call `client.register.clear()`: these
 * four are constructed once at package module scope, so clearing drops them irrecoverably and
 * every later assertion would be about an empty registry.
 */

const QUOTA_EXCEEDED = 'civitai_app_block_storage_quota_exceeded_total';
const USER_QUOTA_UNTRACKED = 'civitai_app_block_storage_user_quota_untracked_total';
const LATENCY = 'civitai_app_block_storage_latency_seconds';

type Values = Array<{ labels: Record<string, string>; value: number; metricName?: string }>;

async function valuesOf(name: string): Promise<Values> {
  const metric = client.register.getSingleMetric(name) as
    | { get(): Promise<{ values: Values }> | { values: Values } }
    | undefined;
  if (!metric) return [];
  const { values } = await metric.get();
  return values;
}

beforeAll(async () => {
  await seedAppBlockStorageMetrics();
});

describe('seedAppBlockStorageMetrics', () => {
  it('🔴 gives each app_block_id-labelled counter a presence beacon, since its label domain is unbounded', async () => {
    // `app_block_id` is omitted, not placeholdered — prom-client drops an unsupplied label, so
    // the row's `app_block_id` is the empty string. It stays 0 forever; its job is to make
    // `absent(<metric>)` mean "the instrument is gone" rather than "no app has hit a ceiling".
    const quota = await valuesOf(QUOTA_EXCEEDED);
    expect(quota.length).toBe(2);
    for (const v of quota) {
      expect(v.value).toBe(0);
      expect(v.labels.app_block_id).toBeUndefined();
    }
    expect(quota.map((v) => v.labels.ceiling).sort()).toEqual(['app', 'user']);

    const untracked = await valuesOf(USER_QUOTA_UNTRACKED);
    expect(untracked.length).toBe(1);
    expect(untracked[0].value).toBe(0);
    expect(untracked[0].labels.app_block_id).toBeUndefined();
  });

  it('🔴 a failing latency read costs the series, never the scrape', async () => {
    // The try/catch is a scrape-AVAILABILITY guard: this runs inside the /api/metrics handler,
    // so a throw out of the seeder 500s the whole response — default metrics, every other
    // seeded counter, the Prisma series. Deleting the catch left the suite green, so the guard
    // had no case.
    const handle = client.register.getSingleMetric(LATENCY) as unknown as {
      get: () => Promise<unknown>;
    };
    const original = handle.get;
    handle.get = () => Promise.reject(new Error('registry read failed'));
    try {
      await expect(seedAppBlockStorageMetrics()).resolves.toBeUndefined();

      // No assertion on the published series: `beforeAll` already published it, so such a
      // check passes whether or not this call wrote anything.
    } finally {
      handle.get = original;
    }

    // Nothing else asserted the patch came back. Neutering the `finally` leaves this file
    // green; the leak only surfaces in whichever case is appended next, attributed to it.
    expect(handle.get).toBe(original);
  });
});
