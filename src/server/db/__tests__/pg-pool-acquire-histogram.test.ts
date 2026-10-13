import { describe, expect, it, vi } from 'vitest';
import client from 'prom-client';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { getClient } from '~/server/db/db-helpers';

// Literal: dashboards query this name.
const PG_POOL_ACQUIRE_HISTOGRAM_NAME = 'node_postgres_pool_acquire_duration_seconds';

async function failAcquire(load: typeof getClient) {
  // Port 1 refuses immediately, so the acquire resolves as an error without a database.
  const pool = load({
    instance: 'primaryRead',
    replicaUrl: 'postgres://user:pass@127.0.0.1:1/db',
    ssl: false,
    connectionTimeout: 2000,
  });
  await expect(pool.connect()).rejects.toThrow();
  await pool.end();
}

async function errCount() {
  const metric = instrumentationRegistry.getSingleMetric(PG_POOL_ACQUIRE_HISTOGRAM_NAME);
  expect(metric).toBeDefined();
  const { values } = await metric!.get();
  return values.find(
    (v) =>
      (v as { metricName?: string }).metricName === `${PG_POOL_ACQUIRE_HISTOGRAM_NAME}_count` &&
      v.labels.pool === 'primaryRead' &&
      v.labels.result === 'err'
  )?.value;
}

/**
 * The app's pg pools are process-global, so the module graph that builds them first owns their
 * closures — and in production that is the instrumentation graph, whose default prom registry
 * /api/metrics never scrapes. Acquire latency therefore has to land in the cross-graph
 * `instrumentationRegistry`, and must not ALSO exist in the default registry, which the scrape
 * concatenates with it.
 */
describe('pg pool acquire histogram', () => {
  it('records an acquire on an app pool in the cross-graph registry', async () => {
    const before = (await errCount()) ?? 0;
    await failAcquire(getClient);
    expect(await errCount()).toBe(before + 1);
    expect(client.register.getSingleMetric(PG_POOL_ACQUIRE_HISTOGRAM_NAME)).toBeUndefined();
  });

  it('a second module graph reuses the same histogram instead of throwing on registration', async () => {
    const before = (await errCount()) ?? 0;
    vi.resetModules();
    const second = await import('~/server/db/db-helpers');
    await failAcquire(second.getClient);
    expect(await errCount()).toBe(before + 1);
  });
});
