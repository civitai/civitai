import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import type { UiState } from 'instantsearch.js';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import singletonRouter from 'next/router';
import { InstantSearchProps } from 'react-instantsearch';
import { createInstantSearchRouterNext } from 'react-instantsearch-router-nextjs';

export const searchIndexes = ['models', 'articles'] as const;
export type SearchIndex = (typeof searchIndexes)[number];
export const searchParamsSchema = z.object({
  query: z.coerce.string().optional(),
  page: z.number().optional(),
});

export type SearchParams = z.output<typeof searchParamsSchema>;

type StoreState = {
  models: ModelSearchParams;
  articles: ArticleSearchParams;
  setSearchParamsByUiState: (uiState: UiState) => void;
  setModelsSearchParams: (filters: Partial<ModelSearchParams>) => void;
  setArticleSearchParams: (filters: Partial<ArticleSearchParams>) => void;
};

type InstantSearchRoutingParser = {
  parseURL: (params: { location: Location }) => UiState;
  routeToState: (routeState: UiState) => UiState;
  stateToRoute: (routeState: UiState) => UiState;
};

export const ModelSearchIndexSortBy = [
  'models:metrics.weightedRating:desc',
  'models:metrics.downloadCount:desc',
  'models:metrics.favoriteCount:desc',
  'models:metrics.commentCount:desc',
  'models:createdAt:desc',
] as const;

const ModelDefaultSortBy = ModelSearchIndexSortBy[0];

const modelSearchParamsSchema = searchParamsSchema
  .extend({
    sortBy: z.enum(ModelSearchIndexSortBy),
    baseModel: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    modelType: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    checkpointType: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

type ModelSearchParams = z.output<typeof modelSearchParamsSchema>;

const modelInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const modelSearchIndexResult = modelSearchParamsSchema.safeParse(QS.parse(location.search));
    const modelSearchIndexData: ModelSearchParams | Record<string, string[]> =
      modelSearchIndexResult.success ? modelSearchIndexResult.data : {};

    return { models: removeEmpty(modelSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const models: ModelSearchParams = routeState.models as ModelSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'version.baseModel': models.baseModel,
      type: models.modelType,
      checkpointType: models.checkpointType,
      'tags.name': models.tags,
    });

    const { query, page, sortBy } = models;

    return {
      models: {
        query,
        page,
        sortBy: sortBy ?? ModelDefaultSortBy,
        refinementList,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const baseModel = uiState.models.refinementList?.['version.baseModel'];
    const modelType = uiState.models.refinementList?.['type'];
    const checkpointType = uiState.models.refinementList?.['checkpointType'];
    const tags = uiState.models.refinementList?.['tags.name'];
    const sortBy = (uiState.models.sortBy as ModelSearchParams['sortBy']) || ModelDefaultSortBy;
    const { query, page } = uiState.models;

    const state: ModelSearchParams = {
      baseModel,
      modelType,
      checkpointType,
      tags,
      sortBy,
      query,
      page,
    };

    return {
      models: state,
    };
  },
};

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

type ArticleSearchParams = z.output<typeof articleSearchParamsSchema>;

const articlesInstantSearchRoutingParser: InstantSearchRoutingParser = {
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
        query,
        page,
        sortBy: sortBy ?? 'articles:stats.favoriteCount:desc',
        refinementList,
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

export const getRoutingForIndex = (index: SearchIndex): InstantSearchRoutingParser => {
  switch (index) {
    case 'models':
      return modelInstantSearchRoutingParser;
    case 'articles':
      return articlesInstantSearchRoutingParser;
  }
};

type SearchStore = ReturnType<typeof useSearchStore>;
export const useSearchStore = create<StoreState>()(
  devtools(
    immer((set) => {
      return {
        models: {}, // Initially, all of these will be empty.
        articles: {},
        // methods
        setSearchParamsByUiState: (uiState: UiState) => {
          const [index] = Object.keys(uiState);

          if (!index) {
            return;
          }

          const routing = getRoutingForIndex(index as SearchIndex);

          switch (index) {
            case 'articles':
              set((state) => {
                state.articles = routing.stateToRoute(uiState).articles as ArticleSearchParams;
              });
            case 'models':
              set((state) => {
                state.models = routing.stateToRoute(uiState).models as ModelSearchParams;
              });
          }
        },
        setModelsSearchParams: (params) =>
          set((state) => {
            state.models = params;
          }),
        setArticleSearchParams: (params) =>
          set((state) => {
            state.articles = params;
          }),
      };
    })
  )
);

export const routing: InstantSearchProps['routing'] = {
  router: createInstantSearchRouterNext({
    singletonRouter,
    routerOptions: {
      createURL({ routeState, location }) {
        let query = '';

        if (routeState.models) {
          query = QS.stringify(routeState.models);
        }
        if (routeState.articles) {
          query = QS.stringify(routeState.articles);
        }

        return `${location.pathname}?${query}`;
      },
      parseURL({ location }) {
        const pattern = /\/search\/([^\/]+)/;
        const match = location.pathname.match(pattern);

        if (!match) {
          throw new Error('Invalid search path');
        }

        const index = match[1] as SearchIndex;

        return getRoutingForIndex(index).parseURL({ location });
      },
    },
  }),
  stateMapping: {
    routeToState(routeState) {
      if (routeState.models) {
        return getRoutingForIndex('models').routeToState(routeState);
      }
      if (routeState.articles) {
        return getRoutingForIndex('articles').routeToState(routeState);
      }

      return routeState;
    },
    stateToRoute(uiState) {
      const [index] = Object.keys(uiState);
      const routing = getRoutingForIndex(index ? (index as SearchIndex) : 'models');
      return routing.stateToRoute(uiState);
    },
  },
};
