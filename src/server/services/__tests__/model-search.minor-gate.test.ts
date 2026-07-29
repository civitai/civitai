import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/v1/models` used to force `disableMinor: true` on every call, hiding
 * minor-flagged models even from a plain SFW request. The gate now comes from
 * the browsing-settings addons inside getModelsRaw, so the search service must
 * forward NO opinion of its own — a hardcoded value here would shadow the live
 * policy (and, since applyAddonExclusions ORs, could never be relaxed).
 */

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: undefined,
  withMeili: vi.fn(),
  MeiliCallTimeoutError: class extends Error {},
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: vi.fn(() => 'model.safetensors'),
}));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/common/model-helpers', () => ({
  createModelFileDownloadUrl: vi.fn(() => '/download'),
}));

async function forwardedInput(input: Record<string, unknown>) {
  mockGetModelsWithVersions.mockResolvedValue({ items: [], nextCursor: undefined });
  const { runModelSearch } = await import('~/server/services/model-search.service');
  await runModelSearch(
    { limit: 10, ...input } as Parameters<typeof runModelSearch>[0],
    {
      browsingLevel: 1,
      nsfwImagePassthrough: false,
      user: undefined,
      baseUrlOrigin: 'https://civitai.com',
    } as Parameters<typeof runModelSearch>[1]
  );
  return mockGetModelsWithVersions.mock.calls[0][0].input;
}

describe('runModelSearch — minor gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards no disableMinor of its own', async () => {
    expect(await forwardedInput({})).not.toHaveProperty('disableMinor', true);
  });

  it('forwards a caller-set disableMinor (the block catalog stays strict)', async () => {
    expect(await forwardedInput({ disableMinor: true })).toHaveProperty('disableMinor', true);
  });

  it('never forwards a browsingLevel from the input — the ctx value is the authority', async () => {
    // browsingLevel now decides the minor gate as well as the level filter, and
    // callers spread parsed query data into this input through a cast.
    const input = await forwardedInput({ browsingLevel: 31 });
    expect(input.browsingLevel).toBe(1);
  });
});
