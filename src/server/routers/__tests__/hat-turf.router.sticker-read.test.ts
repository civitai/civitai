import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TurfService from '~/server/events/turf/turf.service';

// getStickersForImages is public and runs a window query over up to 100 caller-chosen ids, so it
// must stay rate limited and edge cached. Both middlewares no-op outside prod, hence the env mock.

const { mockStickers } = vi.hoisted(() => ({ mockStickers: vi.fn() }));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDev: false,
  isProd: true,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/server/events/turf/turf.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfService>()),
  getTurfStickersForImages: (...args: unknown[]) => mockStickers(...args),
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { hatTurfRouter } from '../hat-turf.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const input = { event: 'birthday2026', imageIds: [1, 2, 3], perImage: 3 };

function signedOutCaller() {
  const cache = { edgeTTL: 0, browserTTL: 0, canCache: true, skip: false } as Record<
    string,
    unknown
  >;
  const caller = hatTurfRouter.createCaller({
    user: undefined,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    ip: '203.0.113.9',
    req: { headers: { 'x-forwarded-for': '203.0.113.9' }, query: {}, url: '/api/trpc/x' },
    res: { setHeader: () => undefined },
    cache,
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
  return { caller, cache };
}

beforeEach(() => {
  mockStickers.mockReset();
  mockStickers.mockResolvedValue({ 1: [] });
  redisMock.redis.packed.hGet.mockReset();
});

describe('hatTurf.getStickersForImages', () => {
  it('refuses a signed-out caller over 60 calls a minute', async () => {
    const now = Date.now();
    redisMock.redis.packed.hGet.mockResolvedValue(Array.from({ length: 61 }, () => now));
    const { caller } = signedOutCaller();
    await expect(caller.getStickersForImages(input)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockStickers).not.toHaveBeenCalled();
  });

  it('marks the response edge cacheable', async () => {
    const { caller, cache } = signedOutCaller();
    await caller.getStickersForImages(input);
    expect(mockStickers).toHaveBeenCalledTimes(1);
    expect(cache.edgeTTL).toBe(60);
  });
});
