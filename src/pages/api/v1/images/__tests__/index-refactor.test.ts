import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  publicBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Behavior-preservation tests for the /api/v1/images refactor that extracted
 * the search + shaping body into runImageSearch. The public endpoint had NO
 * test before this change; these lock in its MATURITY + param contract so the
 * refactor (and the shared helper the block endpoint now also uses) cannot
 * silently change the public endpoint:
 *
 *   - no nsfw            → publicBrowsingLevelsFlag
 *   - nsfw=true          → nsfwBrowsingLevelsFlag (the legacy `?nsfw=` widening,
 *                          mapped INTO browsingLevel by the schema)
 *   - browsingLevel=N    → N (explicit override wins over nsfw)
 *   - restricted region  → sfwBrowsingLevelsFlag (override), regardless of nsfw
 *   - the parsed params (type/sort/limit/cursor + the ...data rest) are passed
 *     through to runImageSearch unchanged, and the helper's items/nextCursor
 *     are returned as-is (same response shape).
 *
 * runImageSearch is mocked so no Prisma/Meili/Flipt is loaded.
 */

const { mockRunImageSearch, mockIsRegionRestricted, mockGetRegion, mockGetServerAuthSession } =
  vi.hoisted(() => ({
    mockRunImageSearch: vi.fn(),
    mockIsRegionRestricted: vi.fn(),
    mockGetRegion: vi.fn(),
    mockGetServerAuthSession: vi.fn(),
  }));

vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: mockRunImageSearch,
}));

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: mockGetRegion,
  isRegionRestricted: mockIsRegionRestricted,
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

// PublicEndpoint passthrough: invoke the handler directly (no auth/CORS/cache
// wrapping needed for the contract assertions).
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => (req: any, res: any) => handler(req, res),
}));

// Keep the eventloop-longtask wrapper inert (the disarmed default path).
vi.mock('~/server/eventloop-longtask', () => ({
  longTaskLabelsArmed: false,
  runWithLongTaskLabel: (_label: string, fn: any) => fn(),
}));

// The bulkhead: always grant a slot (return a no-op release).
vi.mock('~/server/utils/request-bulkhead', () => ({
  acquireBulkheadSlot: () => () => {},
  BulkheadFullError: class extends Error {},
  HEAVY_REQUEST_CONCURRENCY: 10,
}));

// Metrics: no-op timer.
vi.mock('~/server/metrics/feed-image-existence-check.metrics', () => ({
  ensureRegisterFeedImageExistenceCheckMetrics: () => ({
    requestDurationSeconds: { startTimer: () => () => {} },
  }),
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getPagination: () => ({ skip: 0 }),
}));

function fakeRes() {
  const res: any = {
    headersSent: false,
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
    end() {
      return this;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any; headers: Record<string, any> };
}

async function invoke(query: Record<string, unknown>) {
  const mod = await import('../index');
  const handler = mod.default as any;
  const req = {
    method: 'GET',
    query,
    headers: { host: 'civitai.com' },
    url: '/api/v1/images',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('/api/v1/images refactor — public contract preserved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunImageSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockGetRegion.mockReturnValue('US');
    mockIsRegionRestricted.mockReturnValue(false);
    mockGetServerAuthSession.mockResolvedValue(null);
  });

  it('no nsfw → publicBrowsingLevelsFlag', async () => {
    const res = await invoke({});
    expect(res.statusCode).toBe(200);
    expect(mockRunImageSearch).toHaveBeenCalledTimes(1);
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(publicBrowsingLevelsFlag);
  });

  it('nsfw=true → nsfwBrowsingLevelsFlag (legacy widening preserved)', async () => {
    await invoke({ nsfw: 'true' });
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(nsfwBrowsingLevelsFlag);
  });

  it('explicit browsingLevel wins over nsfw', async () => {
    await invoke({ browsingLevel: '7', nsfw: 'true' });
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(7);
  });

  it('restricted region → sfwBrowsingLevelsFlag override even with nsfw=true', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
    await invoke({ nsfw: 'true' });
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  it('passes parsed params (type/limit/sort + ...data) to runImageSearch', async () => {
    await invoke({ type: 'image', limit: '20', sort: 'Newest', modelId: '123' });
    const [input] = mockRunImageSearch.mock.calls[0];
    expect(input.type).toBe('image');
    expect(input.limit).toBe(20);
    // sort + modelId fall into the ...data rest (forwarded verbatim).
    expect(input.data.sort).toBe('Newest');
    expect(input.data.modelId).toBe(123);
    // Maturity knobs are NOT in the search input — resolved into ctx.browsingLevel.
    expect(input.data).not.toHaveProperty('nsfw');
    expect(input.data).not.toHaveProperty('browsingLevel');
  });

  it('returns runImageSearch items + cursor metadata unchanged (shape preserved)', async () => {
    mockRunImageSearch.mockResolvedValue({
      items: [{ id: 1, url: 'x' }],
      nextCursor: 'cursor-42',
    });
    const res = await invoke({});
    expect(res.body.items).toEqual([{ id: 1, url: 'x' }]);
    expect(res.body.metadata.nextCursor).toBe('cursor-42');
  });

  it('429s when paging past the offset cap (guard preserved)', async () => {
    const res = await invoke({ page: '11', limit: '100' });
    expect(res.statusCode).toBe(429);
    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });
});
