import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { semanticArticleSearchRouter } from '~/server/routers/semantic-article-search.router';
import { semanticBountySearchRouter } from '~/server/routers/semantic-bounty-search.router';
import { semanticComicSearchRouter } from '~/server/routers/semantic-comic-search.router';
import { semanticImageSearchRouter } from '~/server/routers/semantic-image-search.router';
import { semanticModelSearchRouter } from '~/server/routers/semantic-model-search.router';
import { setProfanityListReaderForTests } from '~/server/services/profanity-list.service';
import {
  profaneSearchVerdict,
  refuseProfaneSearch,
  SEARCH_REFUSAL_LIMITS,
  searchRefusalBucket,
} from '~/server/utils/search-refusal-budget';
import { publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { z } from 'zod';

// A synthetic token on no real list: this file is public.
const PROFANE = 'zqvoxprofanitytoken';
const listFrom = (source: 'managed' | 'shipped') => ({
  read: async () => ({ blocked: [PROFANE], allowed: null, source }),
});

// Working sets over the shared Redis mock, so the refusal budget actually counts.
const sets = new Map<string, Set<string>>();
const setOf = (key: string) => sets.get(key) ?? sets.set(key, new Set()).get(key)!;
beforeEach(() => {
  sets.clear();
  setProfanityListReaderForTests(listFrom('managed'));
  vi.spyOn(redisMock.redis, 'sCard').mockImplementation(
    (async (key: string) => setOf(key).size) as never
  );
  vi.spyOn(redisMock.redis, 'sAdd').mockImplementation((async (key: string, member: string) => {
    const before = setOf(key).size;
    setOf(key).add(member);
    return setOf(key).size - before;
  }) as never);
  vi.spyOn(redisMock.redis, 'ttl').mockImplementation((async () => 600) as never);
});
const [TEN_MINUTES, DAY] = SEARCH_REFUSAL_LIMITS;
const distinct = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `${PROFANE} ${from + i}`);
afterEach(() => vi.restoreAllMocks());

const features = {
  trpcFlagGuardPerRequest: true,
  isGreen: true,
  semanticArticleSearch: true,
  semanticComicSearch: true,
  modelFeedSearch: true,
  bounties: true,
  semanticBountySearch: true,
  imageSearch: true,
  semanticVideoSearch: true,
};
const req = { headers: {}, socket: { remoteAddress: '10.0.0.9' } };
const ctx = (overrides: object = {}) =>
  ({
    acceptableOrigin: true,
    user: undefined,
    tokenScope: TokenScope.Full,
    req,
    features,
    track: { search: async () => undefined },
    cache: {},
    ...overrides,
  } as never);

// Every semantic search procedure a refusing surface queries. The refusal must come before the
// search runs, so none of these reaches a search service.
const procedures = {
  'semanticArticleSearch.search': () => semanticArticleSearchRouter.createCaller(ctx()).search,
  'semanticComicSearch.search': () => semanticComicSearchRouter.createCaller(ctx()).search,
  'semanticModelSearch.search': () => semanticModelSearchRouter.createCaller(ctx()).search,
  'semanticBountySearch.search': () => semanticBountySearchRouter.createCaller(ctx()).search,
  'semanticImageSearch.search': () => semanticImageSearchRouter.createCaller(ctx()).search,
  'semanticImageSearch.searchVideos': () =>
    semanticImageSearchRouter.createCaller(ctx()).searchVideos,
};

describe('semantic search, flag on, civitai.com', () => {
  it.each(Object.entries(procedures))(
    '%s refuses a profane query on the server, naming no word',
    async (_, procedure) => {
      const call = procedure() as (input: { query: string }) => Promise<unknown>;
      const error = await call({ query: `a ${PROFANE} b` }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error).toMatchObject({ code: 'UNPROCESSABLE_CONTENT', message: 'search_refused' });
      expect(JSON.stringify(error)).not.toContain(PROFANE);
    }
  );
});

describe('profaneSearchVerdict', () => {
  it('flag off (the shipped list): refuses nothing, leaving the browser its own check', async () => {
    setProfanityListReaderForTests(listFrom('shipped'));
    expect(await profaneSearchVerdict([`a ${PROFANE} b`], 'ip:1')).toBeNull();
  });

  it('runs a clean query and refuses a profane one', async () => {
    expect([
      await profaneSearchVerdict(['ordinary words'], 'ip:1'),
      await profaneSearchVerdict([`a ${PROFANE} b`], 'ip:1'),
    ]).toEqual([null, 'refused']);
  });

  // Otherwise refusals test words against the list for free.
  it("once a caller is refused enough distinct queries, refuses its clean ones too, and no one else's", async () => {
    for (const query of distinct(TEN_MINUTES.max))
      expect(await profaneSearchVerdict([query], 'ip:1')).toBe('refused');
    expect([
      await profaneSearchVerdict(['ordinary words'], 'ip:1'),
      await profaneSearchVerdict(['ordinary words'], 'ip:2'),
    ]).toEqual(['limited', null]);
  });

  it('spends nothing on a repeat, so retyping one query cannot lock a person out', async () => {
    for (let i = 0; i < TEN_MINUTES.max * 2; i++)
      expect(await profaneSearchVerdict([`a ${PROFANE} b`], 'ip:1')).toBe('refused');
    expect(await profaneSearchVerdict(['ordinary words'], 'ip:1')).toBeNull();
  });

  it('caps a day as well as ten minutes', async () => {
    // Below the ten-minute cap, so only the daily one can trip.
    const dayKey = (bucket: string) => [...sets.keys()].find((k) => k.includes(`:day:${bucket}`))!;
    expect(await profaneSearchVerdict([PROFANE], 'ip:1')).toBe('refused');
    for (const query of distinct(DAY.max - 1, 1)) setOf(dayKey('ip:1')).add(query);
    expect(await profaneSearchVerdict(['ordinary words'], 'ip:1')).toBe('limited');
  });

  it('flag off: reads no budget at all', async () => {
    setProfanityListReaderForTests(listFrom('shipped'));
    const sCard = vi.mocked(redisMock.redis.sCard);
    sCard.mockClear();
    expect(await profaneSearchVerdict(['ordinary words'], 'ip:1')).toBeNull();
    expect(sCard).not.toHaveBeenCalled();
  });

  it('fails open when the budget cannot be read', async () => {
    vi.mocked(redisMock.redis.sCard).mockRejectedValue(new Error('redis down') as never);
    expect(await profaneSearchVerdict(['ordinary words'], 'ip:1')).toBeNull();
  });
});

describe('semantic search, the budget and the domain', () => {
  const clean = { query: 'ordinary words' };

  it('a caller who spent its refusals is refused a clean semantic search, as 429', async () => {
    // The bucket /api/search derives for the same caller: the two surfaces share one budget.
    const bucket = searchRefusalBucket(req as never);
    for (const query of distinct(TEN_MINUTES.max)) await profaneSearchVerdict([query], bucket);
    await expect(
      semanticArticleSearchRouter.createCaller(ctx()).search(clean)
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('off civitai.com a profane query goes on to the search', async () => {
    const probe = router({
      search: publicProcedure
        .input(z.object({ query: z.string() }))
        .use(refuseProfaneSearch)
        .query(() => 'searched'),
    });
    const offGreen = ctx({ features: { ...features, isGreen: false } });
    expect(await probe.createCaller(offGreen).search({ query: `a ${PROFANE} b` })).toBe('searched');
    // Control: the same probe refuses it on civitai.com.
    await expect(
      probe.createCaller(ctx()).search({ query: `a ${PROFANE} b` })
    ).rejects.toMatchObject({ message: 'search_refused' });
  });
});
