import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunImageSearch, mockIsRegionRestricted, mockHeldLevel } = vi.hoisted(() => ({
  mockRunImageSearch: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
  mockHeldLevel: vi.fn(),
}));

vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: mockRunImageSearch,
  withoutHeldImages: async (items: unknown[]) => items,
}));
vi.mock('~/server/services/model.service', () => ({
  getHeldGalleryLevel: mockHeldLevel,
  isModelGalleryWithheld: async () => false,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({ countryCode: 'XX' }),
  isRegionRestricted: mockIsRegionRestricted,
}));
vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (h: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      h(...args),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import '~/__tests__/mocks/db.mock';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/images/index';

const PUBLIC_CACHE = 'public, s-maxage=300, stale-while-revalidate=150';
const NO_STORE = 'private, no-store';

/** One anonymous request through the REAL `PublicEndpoint`, from a restricted region or not. */
async function call(query: Record<string, string>, restricted: boolean) {
  mockIsRegionRestricted.mockReturnValue(restricted);
  const { req, res, header } = createRealApiPair({
    url: `/api/v1/images?${new URLSearchParams(query)}`,
    query,
  });
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { statusCode: res.statusCode, cacheControl: header('Cache-Control') };
}

/** The same URL from both sides of the region line. */
async function bothRegions(query: Record<string, string>) {
  return [await call(query, false), await call(query, true)];
}

describe('/api/v1/images shared cache by region', () => {
  beforeEach(() => {
    mockRunImageSearch.mockReset().mockResolvedValue({ items: [], nextCursor: undefined });
    mockIsRegionRestricted.mockReset();
    mockHeldLevel.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ['a model gallery above SFW', { modelId: '1', nsfw: 'X' }],
    ['a model gallery at nsfw=true', { modelId: '1', nsfw: 'true' }],
    ['a model gallery at an explicit mature level', { modelId: '1', browsingLevel: '28' }],
    ['a model gallery at X only', { modelId: '1', browsingLevel: '8' }],
    ['a model gallery at XXX only', { modelId: '1', browsingLevel: '16' }],
    ['a model gallery at nsfw=Blocked', { modelId: '1', nsfw: 'Blocked' }],
    ['a model gallery at nsfw=Mature', { modelId: '1', nsfw: 'Mature' }],
    ['a level wider than 32 bits', { modelId: '1', browsingLevel: String(2 ** 32 + 1) }],
    ['a fractional level', { modelId: '1', browsingLevel: '1.5' }],
    ['a negative level', { modelId: '1', browsingLevel: '-1' }],
    ['a feed above SFW', { nsfw: 'true' }],
    ['a post’s images above SFW', { postId: '5', nsfw: 'true' }],
  ])('is never shared-cached for %s, in either region', async (_, query) => {
    for (const { statusCode, cacheControl } of await bothRegions(query)) {
      expect(statusCode).toBe(200);
      expect(cacheControl).toBe(NO_STORE);
    }
  });

  it.each([
    ['a model gallery at the default level', { modelId: '1' }],
    ['a model gallery at the SFW levels', { modelId: '1', browsingLevel: '3' }],
    ['a feed at nsfw=None', { nsfw: 'None' }],
    ['a feed at nsfw=Soft', { nsfw: 'Soft' }],
  ])('keeps the public cache for %s', async (_, query) => {
    for (const { statusCode, cacheControl } of await bothRegions(query)) {
      expect(statusCode).toBe(200);
      expect(cacheControl).toBe(PUBLIC_CACHE);
    }
  });
});
