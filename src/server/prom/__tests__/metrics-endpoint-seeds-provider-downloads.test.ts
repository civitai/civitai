import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';

/**
 * `civitai_provider_download_total` must be scraped at 0 before its first provider download:
 * `increase()` cannot see a series whose first scraped value is above 0, so every download before
 * it would go uncounted. Seeding runs from the `/api/metrics` handler, so these tests go through it.
 */

const { mockGetLiveProviderTokens } = vi.hoisted(() => ({ mockGetLiveProviderTokens: vi.fn() }));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/provider-download/provider-token.store', () => ({
  getLiveProviderTokens: mockGetLiveProviderTokens,
}));

const token = (provider: string) => ({ provider, hash: `h-${provider}`, hourlyCeiling: 100 });

async function scrape(): Promise<string> {
  const mod = await import('~/pages/api/metrics');
  const handler = mod.default as unknown as (
    req: unknown,
    res: { setHeader: (k: string, v: string) => void; send: (body: string) => void }
  ) => Promise<void>;
  let body = '';
  await handler({}, { setHeader: () => undefined, send: (b: string) => (body = b) });
  return body;
}

type Row = { value: number; labels: Record<string, string> };
async function series(): Promise<Record<string, number>> {
  const metric = client.register.getSingleMetric('civitai_provider_download_total');
  const values = ((await metric?.get())?.values ?? []) as Row[];
  return Object.fromEntries(
    values.map((v) => [`${v.labels.provider}/${v.labels.result}/${v.labels.visibility}`, v.value])
  );
}

const reachable = (provider: string) => ({
  [`${provider}/granted/public`]: 0,
  [`${provider}/granted/nonpublic`]: 0,
  [`${provider}/refused_401/unknown`]: 0,
  [`${provider}/refused_429/unknown`]: 0,
  [`${provider}/refused_gate/unknown`]: 0,
});

beforeEach(() => {
  client.register.getSingleMetric('civitai_provider_download_total')?.reset();
});

describe('/api/metrics seeds civitai_provider_download_total', () => {
  it('a scrape publishes every reachable series at 0 for each live provider and unknown', async () => {
    mockGetLiveProviderTokens.mockResolvedValue([token('acme'), token('acme'), token('beta')]);
    const body = await scrape();
    expect(body).toContain(
      'civitai_provider_download_total{provider="beta",result="granted",visibility="nonpublic"} 0'
    );
    expect(await series()).toEqual({
      ...reachable('acme'),
      ...reachable('beta'),
      'unknown/refused_401/unknown': 0,
    });
  });

  it('a provider minted later is seeded on the next scrape, without resetting counts', async () => {
    const { countProviderDownload } = await import('~/server/prom/provider-download.metrics');
    mockGetLiveProviderTokens.mockResolvedValue([token('acme')]);
    await scrape();
    countProviderDownload('acme', 'granted', 'nonpublic');
    mockGetLiveProviderTokens.mockResolvedValue([token('acme'), token('gamma')]);
    await scrape();
    expect(await series()).toEqual({
      ...reachable('acme'),
      'acme/granted/nonpublic': 1,
      ...reachable('gamma'),
      'unknown/refused_401/unknown': 0,
    });
  });

  it('a failed token read still seeds unknown and does not fail the scrape', async () => {
    mockGetLiveProviderTokens.mockRejectedValue(new Error('db down'));
    await expect(scrape()).resolves.toContain('civitai_provider_download_total');
    expect(await series()).toEqual({ 'unknown/refused_401/unknown': 0 });
  });
});
