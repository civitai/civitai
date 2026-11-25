import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';

/**
 * The seam: loading `/api/metrics` publishes all six `civitai_app_block_review_boot_checks_total`
 * series at 0. Only this file sees the `ensureRegisterAppBlockBootCheckMetrics()` call being
 * removed from the endpoint.
 */

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

const NAME = 'civitai_app_block_review_boot_checks_total';

describe('/api/metrics publishes the review boot-check series', () => {
  it('loading the page module seeds mode x result at 0', async () => {
    await import('~/pages/api/metrics');
    const metric = client.register.getSingleMetric(NAME) as unknown as {
      get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }>;
    };
    const { values } = await metric.get();
    expect(values.map((v) => `${v.labels.mode}/${v.labels.result}=${v.value}`).sort()).toEqual([
      'enforce/failed=0',
      'enforce/passed=0',
      'enforce/unavailable=0',
      'shadow/failed=0',
      'shadow/passed=0',
      'shadow/unavailable=0',
    ]);
  });
});
