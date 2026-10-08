import { describe, expect, it } from 'vitest';
import client from 'prom-client';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { getClient } from '~/server/db/db-helpers';

// Literal: dashboards query this name.
const PG_POOL_ACQUIRE_HISTOGRAM_NAME = 'node_postgres_pool_acquire_duration_seconds';

/**
 * The app's pg pools are process-global, so the module graph that builds them first owns their
 * closures — and in production that is the instrumentation graph, whose default prom registry
 * /api/metrics never scrapes. Acquire latency therefore has to land in the cross-graph
 * `instrumentationRegistry`, and must not ALSO exist in the default registry, which the scrape
 * concatenates with it.
 */
describe('pg pool acquire histogram', () => {
  it('records an acquire on an app pool in the cross-graph registry', async () => {
    // Port 1 refuses immediately, so the acquire resolves as an error without a database.
    const pool = getClient({
      instance: 'primaryRead',
      replicaUrl: 'postgres://user:pass@127.0.0.1:1/db',
      ssl: false,
      connectionTimeout: 2000,
    });
    await expect(pool.connect()).rejects.toThrow();
    await pool.end();

    const metric = instrumentationRegistry.getSingleMetric(PG_POOL_ACQUIRE_HISTOGRAM_NAME);
    expect(metric).toBeDefined();
    const { values } = await metric!.get();
    const errCount = values.find(
      (v) =>
        (v as { metricName?: string }).metricName === `${PG_POOL_ACQUIRE_HISTOGRAM_NAME}_count` &&
        v.labels.pool === 'primaryRead' &&
        v.labels.result === 'err'
    );
    expect(errCount?.value).toBe(1);

    expect(client.register.getSingleMetric(PG_POOL_ACQUIRE_HISTOGRAM_NAME)).toBeUndefined();
  });
});
