import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { NsfwLevel } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * article.getById by region: a restricted region gets the same NOT_FOUND as a missing article for
 * an article above SFW (its own level or a connected image in its body; unrated fails closed), as
 * /api/v1/articles/[id] does. Its owner and moderators still read it. Such an answer is never
 * edge-cached, because the edge cache does not key on region.
 */

const { mockGetArticleById, mockIsRegionRestricted } = vi.hoisted(() => ({
  mockGetArticleById: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
}));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getArticleById: mockGetArticleById,
}));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEventDecorationsForEntity: async () => ({}),
}));
vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRegion: () => ({ countryCode: 'XX' }),
  isRegionRestricted: mockIsRegionRestricted,
}));

import { articleRouter } from '../article.router';
import { willEdgeCache } from '~/server/trpc/edge-cache-headers';

const { PG, PG13, R, X } = NsfwLevel;
const OWNER_ID = 42;

function article(nsfwLevel: number, imageLevels: number[] = []) {
  return {
    id: 7,
    userId: OWNER_ID,
    nsfwLevel,
    content: '<p>body</p>',
    contentImages: imageLevels.map((level, i) => ({ id: i + 1, nsfwLevel: level })),
  };
}

const session = { apiKeyId: null, tokenScope: TokenScope.Full };
const scopedKey = {
  apiKeyId: 5,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey' as const, id: 5 },
  tokenScope: TokenScope.ArticlesRead,
};
const oauthToken = {
  apiKeyId: 6,
  apiKeyType: ApiKeyType.Access,
  subject: { type: 'oauth' as const, id: 'client-1' },
  tokenScope: TokenScope.Full,
};

const member = { id: 2, isModerator: false, tier: 'free', muted: false, bannedAt: null };
const moderator = { id: 1, isModerator: true, tier: 'free', muted: false, bannedAt: null };
const owner = { id: OWNER_ID, isModerator: false, tier: 'free', muted: false, bannedAt: null };

/** A signed-out caller's context is edge-cacheable (createContext), as in production. */
function fakeCtx(user: unknown, credential: Record<string, unknown> = session) {
  return {
    acceptableOrigin: true,
    user,
    ...credential,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: user
      ? { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false }
      : { browserTTL: 60, edgeTTL: 60, staleWhileRevalidate: 30, canCache: true, skip: false },
    features: {} as never,
    track: undefined,
  };
}

async function getById(
  restricted: boolean,
  user?: unknown,
  {
    credential = session,
    ssr = false,
  }: { credential?: Record<string, unknown>; ssr?: boolean } = {}
) {
  mockIsRegionRestricted.mockReturnValue(restricted);
  // The server-side render's helpers build their context with no cache.
  const ctx = { ...fakeCtx(user, credential), ...(ssr ? { cache: null } : {}) };
  const caller = articleRouter.createCaller(ctx as never);
  const result = await caller.getById({ id: 7 }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  );
  return { ...result, edgeCached: willEdgeCache(ctx.cache) };
}

describe('article.getById by region', () => {
  beforeEach(() => {
    mockGetArticleById.mockReset();
    mockIsRegionRestricted.mockReset();
  });

  it.each([
    ['an R article', article(R)],
    ['an X article', article(X)],
    ['a PG|R article', article(PG | R)],
    ['a PG article with an R image in its body', article(PG, [PG, R])],
    ['a PG article with a PG|R image in its body', article(PG, [PG | R])],
    ['an unrated article', article(0)],
    ['a PG article with an unrated image in its body', article(PG, [0])],
  ])(
    'is NOT_FOUND for %s in a restricted region, served elsewhere, edge-cached in neither',
    async (_, value) => {
      mockGetArticleById.mockResolvedValue(value);

      const elsewhere = await getById(false);
      const restricted = await getById(true);

      expect(elsewhere.value?.content).toBe('<p>body</p>');
      expect(elsewhere.edgeCached).toBe(false);
      expect(restricted.value).toBeUndefined();
      expect(restricted.error).toBeInstanceOf(TRPCError);
      expect((restricted.error as TRPCError).code).toBe('NOT_FOUND');
    }
  );

  it('answers a restricted caller exactly as a missing article', async () => {
    mockGetArticleById.mockResolvedValue(article(R));
    const aboveSfw = await getById(true);

    mockGetArticleById.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'No article with id 7' })
    );
    const missing = await getById(true);

    expect((aboveSfw.error as TRPCError).code).toBe((missing.error as TRPCError).code);
    expect((aboveSfw.error as TRPCError).message).toBe((missing.error as TRPCError).message);
  });

  it.each([
    ['its owner', owner],
    ['a moderator', moderator],
  ])('still serves an R article to %s in a restricted region', async (_, user) => {
    mockGetArticleById.mockResolvedValue(article(R));
    const { value } = await getById(true, user);
    expect(value?.content).toBe('<p>body</p>');
  });

  it.each([
    ['a scoped key', scopedKey],
    ['an OAuth token', oauthToken],
  ])('is NOT_FOUND for a moderator on %s in a restricted region', async (_, credential) => {
    mockGetArticleById.mockResolvedValue(article(R));
    const { error } = await getById(true, moderator, { credential });
    expect((error as TRPCError).code).toBe('NOT_FOUND');
  });

  it('still serves its owner an R article on a scoped key in a restricted region', async () => {
    mockGetArticleById.mockResolvedValue(article(R));
    const { value } = await getById(true, owner, { credential: scopedKey });
    expect(value?.content).toBe('<p>body</p>');
  });

  it('works in the server-side render, whose context has no cache', async () => {
    mockGetArticleById.mockResolvedValue(article(R));
    expect((await getById(false, undefined, { ssr: true })).value?.content).toBe('<p>body</p>');
    const restricted = await getById(true, undefined, { ssr: true });
    expect((restricted.error as TRPCError).code).toBe('NOT_FOUND');
  });

  it('is NOT_FOUND for a signed-in member in a restricted region', async () => {
    mockGetArticleById.mockResolvedValue(article(R));
    const { error } = await getById(true, member);
    expect((error as TRPCError).code).toBe('NOT_FOUND');
  });

  it('control: serves an SFW article in both regions and keeps it edge-cacheable', async () => {
    mockGetArticleById.mockResolvedValue(article(PG | PG13, [PG, PG13]));
    for (const restricted of [false, true]) {
      const { value, edgeCached } = await getById(restricted);
      expect(value?.content).toBe('<p>body</p>');
      expect(edgeCached).toBe(true);
    }
  });
});
