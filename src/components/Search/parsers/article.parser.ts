import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';

export const ArticlesSearchIndexSortBy = [
  `${ARTICLES_SEARCH_INDEX}:stats.favoriteCount:desc`,
  `${ARTICLES_SEARCH_INDEX}:stats.viewCount:desc`,
  `${ARTICLES_SEARCH_INDEX}:stats.commentCount:desc`,
  `${ARTICLES_SEARCH_INDEX}:createdAt:desc`,
] as const;

const defaultSortBy = ArticlesSearchIndexSortBy[0];

const articleSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('articles'),
    sortBy: z.enum(ArticlesSearchIndexSortBy),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    users: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export type ArticleSearchParams = z.output<typeof articleSearchParamsSchema>;

export const articlesInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const articleSearchIndexResult = articleSearchParamsSchema.safeParse(QS.parse(location.search));
    const articleSearchIndexData: ArticleSearchParams | Record<string, string[]> =
      articleSearchIndexResult.success ? articleSearchIndexResult.data : {};

    return { [ARTICLES_SEARCH_INDEX]: removeEmpty(articleSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const articles: ArticleSearchParams = (routeState[ARTICLES_SEARCH_INDEX] ||
      {}) as ArticleSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'tags.name': articles.tags,
      'user.username': articles.users,
    });

    const { query, sortBy } = articles;

    return {
      [ARTICLES_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const tags = uiState[ARTICLES_SEARCH_INDEX].refinementList?.['tags.name'];
    const users = uiState[ARTICLES_SEARCH_INDEX].refinementList?.['user.username'];

    const sortBy =
      (uiState[ARTICLES_SEARCH_INDEX].sortBy as ArticleSearchParams['sortBy']) || defaultSortBy;

    const { query } = uiState[ARTICLES_SEARCH_INDEX];

    const state: ArticleSearchParams = {
      tags,
      users,
      sortBy,
      query,
    };

    return {
      [ARTICLES_SEARCH_INDEX]: state,
    };
  },
};
