import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetResourceData } = vi.hoisted(() => ({ mockGetResourceData: vi.fn() }));

// The block-token check is its own middleware with its own tests; here the request arrives with
// claims already attached, as the middleware hands it on.
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: unknown) => handler,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: unknown) => handler }));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: async () => ({ allowed: true }),
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: mockGetResourceData,
}));

import handler from '~/pages/api/v1/blocks/generation-resources';

/** Block resource rehydrate leaves out resources of a model flagged `poi`. */

function resource(id: number, poi: boolean) {
  return {
    id,
    name: `v${id}`,
    hasAccess: true,
    baseModel: 'SD 1.5',
    trainedWords: [],
    model: { id, name: `m${id}`, type: 'LORA', nsfw: false, poi, userId: 7 },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/blocks/generation-resources', () => {
  it('returns the unflagged resource and leaves out the flagged one', async () => {
    mockGetResourceData.mockResolvedValue([resource(100, true), resource(200, false)]);
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })), setHeader: vi.fn() };
    await (handler as (req: unknown, res: unknown) => Promise<void>)(
      {
        method: 'GET',
        query: { ids: '100,200' },
        headers: {},
        blockClaims: { blockInstanceId: 'b1', maxBrowsingLevel: 31 },
      },
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const items = json.mock.calls[0][0].items as { versionId: number }[];
    expect(items.map((i) => i.versionId)).toEqual([200]);
  });
});
