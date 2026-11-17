import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { seedProviderDownloadMetrics } from '~/server/prom/provider-download.metrics';

const { mockGetLiveProviderTokens } = vi.hoisted(() => ({ mockGetLiveProviderTokens: vi.fn() }));
vi.mock('~/server/services/provider-download/provider-token.store', () => ({
  getLiveProviderTokens: mockGetLiveProviderTokens,
}));

describe('seedProviderDownloadMetrics', () => {
  it('a token read that never settles does not hold the scrape past the deadline', async () => {
    mockGetLiveProviderTokens.mockReturnValue(new Promise(() => undefined));
    const outcome = await Promise.race([
      seedProviderDownloadMetrics().then(() => 'served'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting after 3s'), 3_000)),
    ]);
    expect(outcome).toBe('served');
    const metric = client.register.getSingleMetric('civitai_provider_download_total');
    expect(((await metric?.get())?.values ?? []).map((v) => v.labels)).toEqual([
      { provider: 'unknown', result: 'refused_401', visibility: 'unknown' },
    ]);
  });
});
