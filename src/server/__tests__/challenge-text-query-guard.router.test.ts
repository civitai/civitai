import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

/**
 * challenge.getInfinite with a query is the semantic search's fallback (it errored) and the route
 * for a Cancelled-only filter (not indexed). It must audit the text the way the semantic path does,
 * or a refused or minor-narrowed query comes back unguarded at the viewer's full level.
 */
const h = vi.hoisted(() => ({
  feed: vi.fn(async (_input: Record<string, unknown>) => ({
    items: [{ id: 1 }],
    nextCursor: undefined,
  })),
  winners: vi.fn(async (_input: Record<string, unknown>) => ({
    items: [{ id: 2 }],
    nextCursor: undefined,
  })),
  includesInappropriate: vi.fn<(input: { prompt?: string }, nsfw?: boolean) => unknown>(),
}));
vi.mock('~/server/services/challenge.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInfiniteChallenges: h.feed,
  getCompletedChallengesWithWinners: h.winners,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/services/search-query-rules', () => ({ matchesQueryRule: async () => false }));
vi.mock('~/utils/metadata/audit', () => ({
  includesInappropriate: h.includesInappropriate,
  includesPoi: () => false,
  includesMinor: () => false,
}));
// An uncapped site, so a test request keeps its NSFW levels.
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestDomainBrowsingLevelCap: () => undefined,
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBrowsingSettingAddons: async () => [],
}));

const { createCallerFactory } = await import('~/server/trpc');
const { challengeRouter } = await import('~/server/routers/challenge.router');

const caller = (user?: Partial<SessionUser>) =>
  createCallerFactory(challengeRouter)({
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    user,
    features: { trpcFlagGuardPerRequest: true, challengePlatform: true, isGreen: false },
    // Every tracker method is a no-op.
    track: new Proxy({}, { get: () => async () => undefined }),
    ip: '127.0.0.1',
    cache: {},
    req: { headers: {} },
    res: undefined,
  } as never);

const ALL = 31;
const VIEWER = { id: 5, isModerator: false };

beforeEach(() => {
  h.feed.mockClear();
  h.winners.mockClear();
  h.includesInappropriate.mockReset().mockReturnValue(false);
});

describe('challenge.getInfinite text query guard', () => {
  it('an allowed query on an unfiltered feed stays unfiltered', async () => {
    // No requested level on a non-green site: the feed applies no level filter (0).
    await caller(VIEWER).getInfinite({ query: 'neon' });
    await caller(VIEWER).getInfinite({});
    const [withQuery, without] = h.feed.mock.calls.map(([input]) => input.browsingLevel);
    expect(withQuery).toBe(without);
  });

  it('a refused query gets no results, never the unguarded text search', async () => {
    h.includesInappropriate.mockReturnValue('inappropriate');
    const result = await caller(VIEWER).getInfinite({ query: 'bad words', browsingLevel: ALL });
    expect(result.items).toEqual([]);
    expect(h.feed).not.toHaveBeenCalled();
  });

  it("a minor verdict narrows a non-moderator's text search to the safe levels", async () => {
    h.includesInappropriate.mockReturnValue('minor');
    await caller(VIEWER).getInfinite({ query: 'young', browsingLevel: ALL });
    expect(h.feed).toHaveBeenCalledTimes(1);
    const level = h.feed.mock.calls[0][0].browsingLevel as number;
    expect(level).toBeGreaterThan(0);
    expect(Flags.intersection(level, ~sfwBrowsingLevelsFlag)).toBe(0);
  });

  it('a minor verdict narrows an unfiltered feed too', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    // No requested level on a non-green site: the feed would apply no level filter (0).
    await caller(VIEWER).getInfinite({ query: 'young' });
    const level = h.feed.mock.calls[0][0].browsingLevel as number;
    expect(level).toBeGreaterThan(0);
    expect(Flags.intersection(level, ~sfwBrowsingLevelsFlag)).toBe(0);
  });

  it('a Cancelled-only filter with a refused query gets no results', async () => {
    h.includesInappropriate.mockReturnValue('inappropriate');
    const result = await caller(VIEWER).getInfinite({
      query: 'bad words',
      status: ['Cancelled'],
      browsingLevel: ALL,
    } as never);
    expect(result.items).toEqual([]);
    expect(h.feed).not.toHaveBeenCalled();
  });

  it('an allowed query searches at the same level as the feed without one', async () => {
    await caller(VIEWER).getInfinite({ query: 'neon', browsingLevel: ALL });
    await caller(VIEWER).getInfinite({ browsingLevel: ALL });
    const [withQuery, without] = h.feed.mock.calls.map(([input]) => input.browsingLevel);
    expect(without).toBe(ALL);
    expect(withQuery).toBe(without);
    // No query, no audit.
    expect(h.includesInappropriate).toHaveBeenCalledTimes(1);
  });

  it('the winners list refuses a refused query, and narrows a minor one', async () => {
    h.includesInappropriate.mockReturnValue('inappropriate');
    const refused = await caller(VIEWER).getCompletedWithWinners({ query: 'bad words' } as never);
    expect(refused.items).toEqual([]);
    expect(h.winners).not.toHaveBeenCalled();

    h.includesInappropriate.mockReturnValue('minor');
    await caller(VIEWER).getCompletedWithWinners({ query: 'young', browsingLevel: ALL } as never);
    const level = h.winners.mock.calls[0][0].browsingLevel as number;
    expect(level).toBeGreaterThan(0);
    expect(Flags.intersection(level, ~sfwBrowsingLevelsFlag)).toBe(0);
  });
});
