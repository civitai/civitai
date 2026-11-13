import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsRegionRestricted } = vi.hoisted(() => ({ mockIsRegionRestricted: vi.fn() }));

vi.mock('~/server/services/article.service', () => ({
  getArticles: async () => ({ items: [], nextCursor: undefined }),
}));
vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: async () => [],
  getCollectionItemCount: async () => [],
}));
vi.mock('~/server/services/collection-cover-visibility', () => ({
  withServableCovers: async (rows: unknown[]) => rows,
}));
vi.mock('~/server/utils/public-cover-image', () => ({
  getCoverBrowsingLevels: async () => () => undefined,
  publicCoverImageSelect: {},
  toPublicCoverImage: () => null,
}));
vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: async () => ({ allowed: true }),
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
import articles from '~/pages/api/v1/articles/index';
import collections from '~/pages/api/v1/collections/index';

const PUBLIC_CACHE = 'public, s-maxage=300, stale-while-revalidate=150';
const NO_STORE = 'private, no-store';

const routes = [
  ['/api/v1/articles', articles],
  ['/api/v1/collections', collections],
] as const;

/** One anonymous request through the REAL `MixedAuthEndpoint`, from a restricted region or not. */
async function call(
  path: string,
  handler: unknown,
  query: Record<string, string>,
  restricted: boolean
) {
  mockIsRegionRestricted.mockReturnValue(restricted);
  const { req, res, header } = createRealApiPair({
    url: `${path}?${new URLSearchParams(query)}`,
    query,
  });
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { statusCode: res.statusCode, cacheControl: header('Cache-Control') };
}

describe.each(routes)('%s shared cache by region, same URL from both regions', (path, handler) => {
  beforeEach(() => mockIsRegionRestricted.mockReset());

  it('never shares ?nsfw=true', async () => {
    for (const restricted of [false, true]) {
      const { statusCode, cacheControl } = await call(path, handler, { nsfw: 'true' }, restricted);
      expect(statusCode).toBe(200);
      expect(cacheControl).toBe(NO_STORE);
    }
  });

  it.each([[{}], [{ nsfw: 'false' }]])('keeps the public cache for %j', async (query) => {
    for (const restricted of [false, true]) {
      const { statusCode, cacheControl } = await call(path, handler, query, restricted);
      expect(statusCode).toBe(200);
      expect(cacheControl).toBe(PUBLIC_CACHE);
    }
  });
});
