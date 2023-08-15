import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';

export const ArticlesSearchIndexSortBy = [
  'articles:stats.favoriteCount:desc',
  'articles:stats.viewCount:desc',
  'articles:stats.commentCount:desc',
  'articles:createdAt:desc',
] as const;

const articleSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('articles'),
    sortBy: z.enum(ArticlesSearchIndexSortBy),
    tags: z
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

    return { articles: removeEmpty(articleSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const articles: ArticleSearchParams = (routeState.articles || {}) as ArticleSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'tags.name': articles.tags,
    });

    const { query, page, sortBy } = articles;

    return {
      articles: {
        sortBy: sortBy ?? 'articles:stats.favoriteCount:desc',
        refinementList,
        query,
        page,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const tags = uiState.articles.refinementList?.['tags.name'];

    const sortBy =
      (uiState.articles.sortBy as ArticleSearchParams['sortBy']) ||
      'articles:stats.favoriteCount:desc';

    const { query, page } = uiState.articles;

    const state: ArticleSearchParams = {
      tags,
      sortBy,
      query,
      page,
    };

    return {
      articles: state,
    };
  },
};
