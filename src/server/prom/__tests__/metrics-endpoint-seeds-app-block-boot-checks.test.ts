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
  it('loading the page module seeds mode x result x reason at 0', async () => {
    await import('~/pages/api/metrics');
    const metric = client.register.getSingleMetric(NAME) as unknown as {
      get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }>;
    };
    const { values } = await metric.get();
    const series = (mode: string) => [
      `${mode}/failed/none=0`,
      `${mode}/passed/none=0`,
      `${mode}/unavailable/body=0`,
      `${mode}/unavailable/contract=0`,
      `${mode}/unavailable/crash=0`,
      `${mode}/unavailable/network=0`,
      `${mode}/unavailable/no-target=0`,
      `${mode}/unavailable/server=0`,
      `${mode}/unavailable/unconfigured=0`,
    ];
    expect(
      values.map((v) => `${v.labels.mode}/${v.labels.result}/${v.labels.reason}=${v.value}`).sort()
    ).toEqual([...series('enforce'), ...series('shadow')]);
  });
});
