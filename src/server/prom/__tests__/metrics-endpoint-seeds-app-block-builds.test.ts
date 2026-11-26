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
  ProbeEndpoint: (handler: unknown) => handler,
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

  // Same seam for the review boot-check counter: loading the page seeds all 18 series at 0.
  it('loading the page module seeds civitai_app_block_review_boot_checks_total (mode x result x reason) at 0', async () => {
    await import('~/pages/api/metrics');
    const metric = client.register.getSingleMetric(
      'civitai_app_block_review_boot_checks_total'
    ) as unknown as {
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
