import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { semanticArticleSearchRouter } from '~/server/routers/semantic-article-search.router';
import { semanticBountySearchRouter } from '~/server/routers/semantic-bounty-search.router';
import { semanticComicSearchRouter } from '~/server/routers/semantic-comic-search.router';
import { semanticImageSearchRouter } from '~/server/routers/semantic-image-search.router';
import { semanticModelSearchRouter } from '~/server/routers/semantic-model-search.router';
import { setProfanityListReaderForTests } from '~/server/services/profanity-list.service';
import { profaneSearchVerdict, SEARCH_REFUSAL_MAX } from '~/server/utils/search-refusal-budget';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// A synthetic token on no real list: this file is public.
const PROFANE = 'zqvoxprofanitytoken';
const listFrom = (source: 'managed' | 'shipped') => ({
  read: async () => ({ blocked: [PROFANE], allowed: null, source }),
});

// A working fixed window over the shared Redis mock, so the refusal budget actually counts.
const counts = new Map<string, number>();
beforeEach(() => {
  counts.clear();
  setProfanityListReaderForTests(listFrom('managed'));
  vi.spyOn(redisMock.redis, 'get').mockImplementation((async (key: string) =>
    counts.has(key) ? String(counts.get(key)) : null) as never);
  vi.spyOn(redisMock.redis, 'incrBy').mockImplementation((async (key: string, by: number) => {
    counts.set(key, (counts.get(key) ?? 0) + by);
    return counts.get(key);
  }) as never);
  vi.spyOn(redisMock.redis, 'ttl').mockImplementation((async () => 600) as never);
});
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
const ctx = (overrides: object = {}) =>
  ({
    acceptableOrigin: true,
    user: undefined,
    tokenScope: TokenScope.Full,
    req: { headers: {}, socket: { remoteAddress: '10.0.0.9' } },
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
  it("once a caller spends its refusals, refuses its clean queries too, and no one else's", async () => {
    for (let i = 0; i < SEARCH_REFUSAL_MAX; i++)
      expect(await profaneSearchVerdict([PROFANE], 'ip:1')).toBe('refused');
    expect([
      await profaneSearchVerdict(['ordinary words'], 'ip:1'),
      await profaneSearchVerdict(['ordinary words'], 'ip:2'),
    ]).toEqual(['limited', null]);
  });
});
