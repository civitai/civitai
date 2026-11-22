import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord, isUsableBlockedEntry } from '@civitai/mod-utils/profanity/word-rules';
import { beforeEach, describe, expect, it } from 'vitest';
import { getProfanityFilter } from '~/libs/profanity-simple';
import { semanticArticleSearchRouter } from '~/server/routers/semantic-article-search.router';
import { semanticBountySearchRouter } from '~/server/routers/semantic-bounty-search.router';
import { semanticComicSearchRouter } from '~/server/routers/semantic-comic-search.router';
import { semanticImageSearchRouter } from '~/server/routers/semantic-image-search.router';
import { semanticModelSearchRouter } from '~/server/routers/semantic-model-search.router';
import { setProfanityListReaderForTests } from '~/server/services/profanity-list.service';
import { refuseProfaneSearch } from '~/server/utils/refuse-profane-search';
import { publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { z } from 'zod';

// A synthetic token on no real list: this file is public.
const PROFANE = 'zqvoxprofanitytoken';
// A shipped entry read at runtime, never written down.
const SHIPPED = blockedWords
  .map(cleanWord)
  .find(
    (word) =>
      isUsableBlockedEntry(word) &&
      /^[a-z]+$/.test(word) &&
      getProfanityFilter().clean(word) !== word
  ) as string;
const listFrom = (source: 'managed' | 'shipped') => ({
  read: async () => ({ blocked: [PROFANE], allowed: null, source }),
});

beforeEach(() => setProfanityListReaderForTests(listFrom('managed')));

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

// The browser leaves these searches to the server whatever the flag says, so the server must check
// them whatever the flag says.
describe('semantic search with the flag off, or the list unreadable', () => {
  it.each(Object.entries(procedures))('%s still refuses a shipped word', async (_, procedure) => {
    const call = procedure() as (input: { query: string }) => Promise<unknown>;
    setProfanityListReaderForTests(listFrom('shipped'));
    await expect(call({ query: `a ${SHIPPED} b` })).rejects.toMatchObject({
      message: 'search_refused',
    });
    setProfanityListReaderForTests({ read: () => Promise.reject(new Error('list down')) });
    await expect(call({ query: `a ${SHIPPED} c` })).rejects.toMatchObject({
      message: 'search_refused',
    });
  });
});

describe('semantic search, the domain', () => {
  it('off civitai.com a profane query goes on to the search', async () => {
    const probe = router({
      search: publicProcedure
        .input(z.object({ query: z.string() }))
        .use(refuseProfaneSearch)
        .query(() => 'searched'),
    });
    const offGreen = ctx({ features: { ...features, isGreen: false } });
    expect(await probe.createCaller(offGreen).search({ query: `a ${PROFANE} b` })).toBe('searched');
    expect(await probe.createCaller(ctx()).search({ query: 'ordinary words' })).toBe('searched');
    // Control: the same probe refuses it on civitai.com.
    await expect(
      probe.createCaller(ctx()).search({ query: `a ${PROFANE} b` })
    ).rejects.toMatchObject({ message: 'search_refused' });
  });
});
