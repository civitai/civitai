import { describe, expect, it } from 'vitest';
import {
  ArticlesSearchIndexSortBy,
  articlesInstantSearchRoutingParser,
} from '~/components/Search/parsers/article.parser';
import type { InstantSearchRoutingParser } from '~/components/Search/parsers/base';
import {
  BountiesSearchIndexSortBy,
  bountiesInstantSearchRoutingParser,
} from '~/components/Search/parsers/bounties.parser';
import {
  CollectionsSearchIndexSortBy,
  collectionsInstantSearchRoutingParser,
} from '~/components/Search/parsers/collection.parser';
import {
  ComicsSearchIndexSortBy,
  comicsInstantSearchRoutingParser,
} from '~/components/Search/parsers/comic.parser';
import {
  ImagesSearchIndexSortBy,
  imagesInstantSearchRoutingParser,
} from '~/components/Search/parsers/image.parser';
import {
  ModelSearchIndexSortBy,
  modelInstantSearchRoutingParser,
} from '~/components/Search/parsers/model.parser';
import {
  ToolsSearchIndexSortBy,
  toolsInstantSearchRoutingParser,
} from '~/components/Search/parsers/tool.parser';
import {
  UsersSearchIndexSortBy,
  usersInstantSearchRoutingParser,
} from '~/components/Search/parsers/user.parser';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { QS } from '~/utils/qs';

const parseSearch = (parser: InstantSearchRoutingParser, index: string, search: string) =>
  parser.parseURL({ location: { search } as unknown as Location })[index] as Record<
    string,
    unknown
  >;

const parseParams = (
  parser: InstantSearchRoutingParser,
  index: string,
  params: Record<string, unknown>
) => parseSearch(parser, index, `?${QS.stringify(params)}`);

const parserCases = [
  {
    name: 'articles',
    index: ARTICLES_SEARCH_INDEX,
    parser: articlesInstantSearchRoutingParser,
    arrayParams: ['tags', 'users'],
    sortBy: ArticlesSearchIndexSortBy[1],
  },
  {
    name: 'bounties',
    index: BOUNTIES_SEARCH_INDEX,
    parser: bountiesInstantSearchRoutingParser,
    arrayParams: ['baseModel', 'users', 'tags', 'type'],
    sortBy: BountiesSearchIndexSortBy[1],
  },
  {
    name: 'collections',
    index: COLLECTIONS_SEARCH_INDEX,
    parser: collectionsInstantSearchRoutingParser,
    arrayParams: ['users', 'type'],
    sortBy: CollectionsSearchIndexSortBy[1],
  },
  {
    name: 'comics',
    index: COMICS_SEARCH_INDEX,
    parser: comicsInstantSearchRoutingParser,
    arrayParams: ['genre'],
    sortBy: ComicsSearchIndexSortBy[1],
  },
  {
    name: 'images',
    index: IMAGES_SEARCH_INDEX,
    parser: imagesInstantSearchRoutingParser,
    arrayParams: ['baseModel', 'aspectRatio', 'tags', 'tools', 'techniques', 'users'],
    sortBy: ImagesSearchIndexSortBy[1],
  },
  {
    name: 'models',
    index: MODELS_SEARCH_INDEX,
    parser: modelInstantSearchRoutingParser,
    arrayParams: ['baseModel', 'modelType', 'checkpointType', 'tags', 'users', 'category'],
    sortBy: ModelSearchIndexSortBy[1],
  },
  {
    name: 'tools',
    index: TOOLS_SEARCH_INDEX,
    parser: toolsInstantSearchRoutingParser,
    arrayParams: ['company', 'type'],
    sortBy: ToolsSearchIndexSortBy[1],
  },
  {
    name: 'users',
    index: USERS_SEARCH_INDEX,
    parser: usersInstantSearchRoutingParser,
    arrayParams: [],
    sortBy: UsersSearchIndexSortBy[1],
  },
];

describe.each(parserCases)('$name parser', ({ index, parser, arrayParams, sortBy }) => {
  it('keeps numeric and boolean-looking values in every array param, as strings', () => {
    const params: Record<string, unknown> = { query: 'art', sortBy };
    arrayParams.forEach((param, i) => {
      params[param] = i % 2 === 0 ? 2026 : true;
    });

    const state = parseParams(parser, index, params);

    expect(state.query).toBe('art');
    expect(state.sortBy).toBe(sortBy);
    arrayParams.forEach((param, i) => {
      expect(state[param]).toEqual([i % 2 === 0 ? '2026' : 'true']);
    });
  });

  it('drops only an unparseable sortBy', () => {
    const params: Record<string, unknown> = { query: 'art', sortBy: 'bogus' };
    arrayParams.forEach((param) => {
      params[param] = 'anime';
    });

    const state = parseParams(parser, index, params);

    expect(state.sortBy).toBeUndefined();
    expect(state.query).toBe('art');
    arrayParams.forEach((param) => {
      expect(state[param]).toEqual(['anime']);
    });
  });
});

describe('articles parser, on the query strings that reported the bug', () => {
  const articles = (search: string) =>
    parseSearch(articlesInstantSearchRoutingParser, ARTICLES_SEARCH_INDEX, search);

  it('keeps a numeric tag and its sibling query', () => {
    expect(articles('?tags=2026&query=art')).toEqual({ tags: ['2026'], query: 'art' });
  });

  it('keeps a boolean-looking tag and its sibling query', () => {
    expect(articles('?tags=true&query=art')).toEqual({ tags: ['true'], query: 'art' });
  });

  it('leaves an alphanumeric tag alone', () => {
    expect(articles('?tags=1k&query=art')).toEqual({ tags: ['1k'], query: 'art' });
  });

  it('keeps repeated values for one param together', () => {
    expect(articles('?tags=anime&tags=2026')).toEqual({ tags: ['anime', '2026'] });
  });

  it('drops an unparseable sortBy without taking the other params with it', () => {
    expect(articles('?sortBy=bogus&query=art&tags=anime&users=alice')).toEqual({
      query: 'art',
      tags: ['anime'],
      users: ['alice'],
    });
  });

  it('returns an empty state when the only param present is unparseable', () => {
    expect(articles('?sortBy=bogus')).toEqual({});
  });
});
