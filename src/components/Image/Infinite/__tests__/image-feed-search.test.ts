import { describe, expect, it } from 'vitest';
import {
  ignoredWhileSearching,
  imageFeedUrlFromLegacySearch,
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
        period: MetricTimeframe.Week,
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
      postedAfter: new Date('2026-11-04T15:00:00Z'),
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
  });
});

describe('imageFeedUrlFromLegacySearch', () => {
  const parse = (url: string) => new URL(url, 'https://x');

  it('carries the query, user, base model and resolved tags to the feed, dropping the sort', () => {
    const url = parse(
      imageFeedUrlFromLegacySearch(
        {
          query: 'red  dragon ',
          users: 'someone',
          baseModel: ['SDXL 1.0', 'Pony'],
          tags: 'dragon',
          sortBy: 'images_v6:stats.reactionCountAllTime:desc',
        },
        [12]
      )
    );
    expect(url.pathname).toBe('/images');
    expect(url.searchParams.get('query')).toBe('red dragon');
    expect(url.searchParams.get('username')).toBe('someone');
    expect(url.searchParams.getAll('baseModels')).toEqual(['SDXL 1.0', 'Pony']);
    expect(url.searchParams.getAll('tags')).toEqual(['12']);
    expect(url.searchParams.has('sort')).toBe(false);
  });

  it('keeps a legacy sort as the feed sort when there is no query', () => {
    const sortOf = (sortBy: string) =>
      parse(imageFeedUrlFromLegacySearch({ sortBy })).searchParams.get('sort');
    expect(sortOf('images_v6:stats.reactionCountAllTime:desc')).toBe(ImageSort.MostReactions);
    expect(sortOf('images_v6:createdAt:desc')).toBe(ImageSort.Newest);
    expect(sortOf('images_v6:createdAt:asc')).toBe(ImageSort.Oldest);
    expect(imageFeedUrlFromLegacySearch({})).toBe('/images');
  });
});
