import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// The real rateLimit middleware, which skips itself under test unless isTest is false.
vi.mock('~/env/other', async () => ({
  ...(await vi.importActual<typeof EnvOther>('~/env/other')),
  isDev: false,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(async () => undefined) }));
vi.mock('~/server/services/semantic-challenge-search.service', () => ({
  searchSemanticChallenges: async () => ({ items: [], nextCursor: undefined }),
}));
vi.mock('~/server/services/semantic-crucible-search.service', () => ({
  searchSemanticCrucibles: async () => ({ items: [], nextCursor: undefined }),
}));

const { createCallerFactory } = await import('~/server/trpc');
const { semanticChallengeSearchRouter } = await import(
  '~/server/routers/semantic-challenge-search.router'
);
const { semanticCrucibleSearchRouter } = await import(
  '~/server/routers/semantic-crucible-search.router'
);

const recent = (n: number) => Array.from({ length: n }, (_, i) => Date.now() - i * 500);

const routers = [
  {
    name: 'semanticChallengeSearch',
    search: (ctx: never) =>
      createCallerFactory(semanticChallengeSearchRouter)(ctx).search({ query: 'neon' }),
    features: { challengePlatform: true, semanticChallengeSearch: true },
  },
  {
    name: 'semanticCrucibleSearch',
    search: (ctx: never) =>
      createCallerFactory(semanticCrucibleSearchRouter)(ctx).search({ query: 'neon' }),
    features: { crucible: true, semanticCrucibleSearch: true },
  },
];

beforeEach(() => {
  redisMock.redis.packed.hGet.mockReset().mockResolvedValue([]);
});

describe.each(routers)('$name.search rate limit', ({ search, features }) => {
  const call = (user?: { id: number }) =>
    search({
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      user: user && { ...user, isModerator: false },
      features: { trpcFlagGuardPerRequest: true, ...features },
      track: { search: vi.fn(async () => undefined) },
      ip: '127.0.0.1',
      cache: {},
      req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res: { setHeader: () => undefined },
    } as never);

  // Signed-out visitors share an IP bucket, so they get the lower limit.
  it.each([
    { who: 'signed out', user: undefined, limit: 20 },
    { who: 'signed in', user: { id: 42 }, limit: 60 },
  ])('$who: allows $limit searches a minute', async ({ user, limit }) => {
    redisMock.redis.packed.hGet.mockResolvedValue(recent(limit - 1));
    await expect(call(user)).resolves.toMatchObject({ items: [] });
    redisMock.redis.packed.hGet.mockResolvedValue(recent(limit));
    await expect(call(user)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});
