import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as SemanticSearch from '~/server/services/semantic-image-search.service';

// The own-images path (users without image search, searching their own images) has a lower
// per-user limit than the flagged path. The limiter is skipped under vitest unless `isTest` is off.

const h = vi.hoisted(() => ({
  flagOn: false,
  search: vi.fn(),
  hSetWithTTL: vi.fn(async () => undefined),
}));

vi.mock('~/env/other', async () => ({
  ...(await vi.importActual<typeof EnvOther>('~/env/other')),
  isDev: false,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: h.hSetWithTTL }));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ imageSearch: h.flagOn }),
}));
vi.mock('~/server/services/semantic-image-search.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SemanticSearch>()),
  searchSemanticImages: h.search,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { semanticImageSearchRouter } from '~/server/routers/semantic-image-search.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const mockHGet = redisMock.redis.packed.hGet;
// A user per test: the limiter also keeps a per-process count for each user.
const viewer = (id: number) => ({
  id,
  username: `fox${id}`,
  isModerator: false,
  muted: false,
  onboarding: 0x1f,
});

const search = (id: number, own: boolean) =>
  semanticImageSearchRouter
    .createCaller({
      acceptableOrigin: true,
      user: viewer(id),
      tokenScope: TokenScope.Full,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      features: {},
      track: { search: vi.fn().mockResolvedValue(undefined) },
    } as never)
    .search({ query: 'kuro', usernames: own ? [`fox${id}`] : undefined });

/** `n` recorded attempts across the last 50 seconds; a fresh array per read, as the store gives. */
const recent = (n: number) => Array.from({ length: n }, (_, i) => Date.now() - i * 2_000);
/** `n` attempts in the own-images bucket only, so sharing the general bucket would read as empty. */
const ownBucket = (n: number) => async (key: string) =>
  key.endsWith(':semanticImageSearch:search:own') ? recent(n) : [];

beforeEach(() => {
  vi.clearAllMocks();
  h.flagOn = false;
  h.search.mockResolvedValue({ items: [], nextCursor: undefined });
  mockHGet.mockResolvedValue([]);
});

describe('semanticImageSearch own-images rate limit', () => {
  it('refuses the 21st own-images search in a minute', async () => {
    mockHGet.mockImplementation(ownBucket(20));
    await expect(search(1, true)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(h.search).not.toHaveBeenCalled();
  });

  it('serves the 20th', async () => {
    mockHGet.mockImplementation(ownBucket(19));
    await expect(search(2, true)).resolves.toBeDefined();
  });

  it('leaves the flagged path at its own limit', async () => {
    h.flagOn = true;
    mockHGet.mockImplementation(async () => recent(20));
    await expect(search(3, false)).resolves.toBeDefined();
  });
});
