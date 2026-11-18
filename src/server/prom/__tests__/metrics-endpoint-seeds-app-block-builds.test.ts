import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';

/**
 * The seam: loading `/api/metrics` publishes every reachable
 * `civitai_app_block_builds_total` series at 0. `ensureRegisterAppBlockBuildMetrics` is
 * inert without that caller, and `app-block-build.metrics.test.ts` calls it itself, so only
 * this file sees the call being removed.
 */

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

const NAME = 'civitai_app_block_builds_total';

describe('/api/metrics publishes the App Block build-outcome series', () => {
  it('loading the page module seeds the series at 0', async () => {
    await import('~/pages/api/metrics');
    const metric = client.register.getSingleMetric(NAME) as unknown as {
      get(): Promise<{ values: { value: number }[] }>;
    };
    const { values } = await metric.get();
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v.value === 0)).toBe(true);
  });
});
