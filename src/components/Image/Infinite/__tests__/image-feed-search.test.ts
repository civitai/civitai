import { describe, expect, it, vi } from 'vitest';
import {
  ignoredWhileSearching,
  imageFeedUrlFromLegacySearch,
  searchPeriodChange,
  toSemanticImageSearchInput,
} from '~/components/Image/Infinite/image-feed-search';
import { ImageSort } from '~/server/common/enums';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';

const now = new Date('2026-11-11T15:42:00Z');

describe('toSemanticImageSearchInput', () => {
  it('sends the filters the index can apply and never the ones it cannot', () => {
    const input = toSemanticImageSearchInput({
      query: 'castle',
      browsingLevel: 1,
      now,
      filters: {
        tags: [5],
        baseModels: ['Flux.1 D'],
        types: [MediaType.image],
        username: 'someone',
        userId: 7,
        period: MetricTimeframe.Week,
        fromPlatform: true,
        tools: [9],
        techniques: [3],
        remixesOnly: true,
        followed: true,
      },
    });
    expect(input).toEqual({
      query: 'castle',
      browsingLevel: 1,
      tagIds: [5],
      excludedTagIds: undefined,
      baseModels: ['Flux.1 D'],
      types: [MediaType.image],
      usernames: ['someone'],
      userIds: [7],
      postedAfter: new Date('2026-11-04T15:00:00Z'),
      fromPlatform: true,
      limit: 50,
    });
  });

  it('puts no date bound on all time', () => {
    const input = toSemanticImageSearchInput({
      query: 'castle',
      browsingLevel: 1,
      now,
      filters: { period: MetricTimeframe.AllTime },
    });
    expect(input.postedAfter).toBeUndefined();
  });
});

describe('searchPeriodChange', () => {
  const { AllTime, Week, Month } = MetricTimeframe;
  const start = { searching: true, wasSearching: false };
  const idle = { searching: false, wasSearching: false };

  it('starts a search over all time and keeps the feed period to give back', () => {
    expect(searchPeriodChange({ ...start, period: Week, savedPeriod: undefined })).toEqual({
      write: AllTime,
      savedPeriod: Week,
    });
    expect(searchPeriodChange({ ...start, period: AllTime, savedPeriod: undefined })).toBeNull();
  });

  it('leaves a period picked during the search alone, across a reload too', () => {
    expect(
      searchPeriodChange({ searching: true, wasSearching: true, period: Month, savedPeriod: Week })
    ).toBeNull();
    expect(searchPeriodChange({ ...start, period: Month, savedPeriod: Week })).toBeNull();
  });

  it('gives the feed its period back without a search, unless one was picked meanwhile', () => {
    const clear = { searching: false, wasSearching: true };
    expect(searchPeriodChange({ ...clear, period: AllTime, savedPeriod: Week })).toEqual({
      write: Week,
      savedPeriod: undefined,
    });
    // A later visit after leaving the feed mid-search.
    expect(searchPeriodChange({ ...idle, period: AllTime, savedPeriod: Week })).toEqual({
      write: Week,
      savedPeriod: undefined,
    });
    expect(searchPeriodChange({ ...clear, period: Month, savedPeriod: Week })).toEqual({
      savedPeriod: undefined,
    });
    expect(searchPeriodChange({ ...idle, period: Week, savedPeriod: undefined })).toBeNull();
  });
});

describe('ignoredWhileSearching', () => {
  it('names the switched-on filters the search will not apply', () => {
    expect(
      ignoredWhileSearching({
        tools: [9],
        withMeta: false,
        followed: true,
        baseModels: ['SDXL 1.0'],
      })
    ).toEqual(['tools', 'followed']);
    expect(ignoredWhileSearching({ newCreators: true })).toEqual(['newCreators']);
  });
});

describe('imageFeedUrlFromLegacySearch', () => {
  const parse = (url: string) => new URL(url, 'https://x');
  const tagIdsByName: Record<string, number> = { dragon: 12, castle: 40 };
  const resolveTags = vi.fn(async (names: string[]) =>
    names.filter((name) => tagIdsByName[name]).map((name) => ({ id: tagIdsByName[name], name }))
  );

  it('carries the query, user, base model and tags to the feed, dropping the sort', async () => {
    const url = parse(
      await imageFeedUrlFromLegacySearch(
        {
          query: 'red  dragon ',
          users: 'someone',
          baseModel: ['SDXL 1.0', 'Pony'],
          tags: ['dragon', 'castle'],
          sortBy: 'images_v6:stats.reactionCountAllTime:desc',
        },
        resolveTags
      )
    );
    expect(url.pathname).toBe('/images');
    expect(url.searchParams.get('query')).toBe('red dragon');
    expect(url.searchParams.get('username')).toBe('someone');
    expect(url.searchParams.getAll('baseModels')).toEqual(['SDXL 1.0', 'Pony']);
    expect(url.searchParams.getAll('tags')).toEqual(['12', '40']);
    expect(url.searchParams.has('sort')).toBe(false);
  });

  it('looks up at most 20 tag names', async () => {
    resolveTags.mockClear();
    const tags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    await imageFeedUrlFromLegacySearch({ query: 'x', tags }, resolveTags);
    expect(resolveTags.mock.calls[0][0]).toHaveLength(20);
  });

  it('keeps a legacy sort as the feed sort when there is no query', async () => {
    const sortOf = async (sortBy: string) =>
      parse(await imageFeedUrlFromLegacySearch({ sortBy }, resolveTags)).searchParams.get('sort');
    expect(await sortOf('images_v6:stats.reactionCountAllTime:desc')).toBe(ImageSort.MostReactions);
    expect(await sortOf('images_v6:createdAt:desc')).toBe(ImageSort.Newest);
    expect(await sortOf('images_v6:createdAt:asc')).toBe(ImageSort.Oldest);
    expect(await imageFeedUrlFromLegacySearch({}, resolveTags)).toBe('/images');
  });

  it('keeps a tag name that matches no tag as a word in the query, rather than dropping it', async () => {
    const url = parse(
      await imageFeedUrlFromLegacySearch({ query: 'red', tags: ['dragon', 'wyvern'] }, resolveTags)
    );
    expect(url.searchParams.get('query')).toBe('red wyvern');
    expect(url.searchParams.getAll('tags')).toEqual(['12']);
  });
});
