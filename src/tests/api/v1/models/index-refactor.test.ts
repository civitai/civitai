import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  publicBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Behavior-preservation tests for the /api/v1/models refactor that extracted
 * the search + shaping body into runModelSearch. The public endpoint had NO
 * test before this change; these lock in its MATURITY contract so the refactor
 * (and the shared helper the block endpoint now also uses) cannot silently
 * change the public endpoint:
 *
 *   - nsfw off  → publicBrowsingLevelsFlag, nsfwImagePassthrough false
 *   - nsfw on   → allBrowsingLevelsFlag,    nsfwImagePassthrough true
 *   - restricted region → sfwBrowsingLevelsFlag (override), regardless of nsfw
 *
 * The model service + Meili are mocked so no Prisma/Meili is loaded.
 */

const { mockRunModelSearch, mockResolveModelSearchIds, mockIsRegionRestricted, mockGetRegion } =
  vi.hoisted(() => ({
    mockRunModelSearch: vi.fn(),
    mockResolveModelSearchIds: vi.fn(),
    mockIsRegionRestricted: vi.fn(),
    mockGetRegion: vi.fn(),
  }));

vi.mock('~/server/services/model-search.service', () => ({
  runModelSearch: mockRunModelSearch,
  resolveModelSearchIds: mockResolveModelSearchIds,
  ModelSearchMeiliTimeoutError: class extends Error {},
}));

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: mockGetRegion,
  isRegionRestricted: mockIsRegionRestricted,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  // Passthrough: invoke handler with no session user (the anon public path).
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, undefined),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: () => ({ baseUrl: { origin: 'https://civitai.com' }, nextPage: undefined }),
  getPagination: () => ({ skip: 0 }),
}));

vi.mock('~/server/services/user.service', () => ({
  getUserBookmarkCollections: vi.fn().mockResolvedValue([]),
}));

function fakeRes() {
  const res: any = {
    headers: {},
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any; headers: Record<string, any> };
}

async function invoke(query: Record<string, unknown>) {
  const mod = await import('~/pages/api/v1/models/index');
  const handler = mod.default as any;
  const req = {
    method: 'GET',
    query,
    headers: { host: 'civitai.com' },
    url: '/api/v1/models',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('/api/v1/models refactor — public maturity contract preserved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockGetRegion.mockReturnValue('US');
    mockIsRegionRestricted.mockReturnValue(false);
  });

  it('nsfw off → publicBrowsingLevelsFlag + nsfwImagePassthrough false', async () => {
    const res = await invoke({});
    expect(res.statusCode).toBe(200);
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(publicBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(false);
  });

  it('nsfw=true → allBrowsingLevelsFlag + nsfwImagePassthrough true (legacy widening kept)', async () => {
    const res = await invoke({ nsfw: 'true' });
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(allBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(true);
  });

  it('restricted region → sfwBrowsingLevelsFlag override even with nsfw=true', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
    const res = await invoke({ nsfw: 'true' });
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    // nsfwImagePassthrough still mirrors the client nsfw flag — unchanged from
    // pre-refactor behavior (the region override only narrows browsingLevel).
    expect(ctx.nsfwImagePassthrough).toBe(true);
  });

  it('query path uses the same browsingLevel for the Meili pre-step', async () => {
    await invoke({ query: 'foo', nsfw: 'true' });
    expect(mockResolveModelSearchIds).toHaveBeenCalledTimes(1);
    expect(mockResolveModelSearchIds.mock.calls[0][0].browsingLevel).toBe(allBrowsingLevelsFlag);
  });

  it('401s on favorites/hidden without a user (authed-only options gate preserved)', async () => {
    const res = await invoke({ favorites: 'true' });
    expect(res.statusCode).toBe(401);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });
});
