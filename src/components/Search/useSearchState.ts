import { QS } from '~/utils/qs';
import type { UiState } from 'instantsearch.js';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import singletonRouter from 'next/router';
import { InstantSearchProps } from 'react-instantsearch';
import { createInstantSearchRouterNext } from 'react-instantsearch-router-nextjs';
import { SearchIndex, InstantSearchRoutingParser } from './parsers/base';
import { ImageSearchParams, imagesInstantSearchRoutingParser } from './parsers/image.parser';
import {
  ModelSearchParams,
  modelInstantSearchRoutingParser,
} from '~/components/Search/parsers/model.parser';
import {
  ArticleSearchParams,
  articlesInstantSearchRoutingParser,
} from '~/components/Search/parsers/article.parser';
import {
  UserSearchParams,
  usersInstantSearchRoutingParser,
} from '~/components/Search/parsers/user.parser';

type StoreState = {
  models: ModelSearchParams;
  images: ImageSearchParams;
  articles: ArticleSearchParams;
  users: UserSearchParams;
  setSearchParamsByUiState: (uiState: UiState) => void;
  setModelsSearchParams: (filters: Partial<ModelSearchParams>) => void;
  setImagesSearchParams: (filters: Partial<ImageSearchParams>) => void;
  setArticleSearchParams: (filters: Partial<ArticleSearchParams>) => void;
  setUserSearchParams: (filters: Partial<UserSearchParams>) => void;
};

export const getRoutingForIndex = (index: SearchIndex): InstantSearchRoutingParser => {
  switch (index) {
    case 'models':
      return modelInstantSearchRoutingParser;
    case 'images':
      return imagesInstantSearchRoutingParser;
    case 'articles':
      return articlesInstantSearchRoutingParser;
    case 'users':
      return usersInstantSearchRoutingParser;
  }
};

type SearchStore = ReturnType<typeof useSearchStore>;
export const useSearchStore = create<StoreState>()(
  devtools(
    immer((set) => {
      return {
        models: {}, // Initially, all of these will be empty.
        images: {},
        articles: {},
        users: {},
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
              break;
            case 'models':
              set((state) => {
                state.models = routing.stateToRoute(uiState).models as ModelSearchParams;
              });
              break;
            case 'images':
              set((state) => {
                state.images = routing.stateToRoute(uiState).images as ImageSearchParams;
              });
              break;
            case 'users':
              set((state) => {
                state.users = routing.stateToRoute(uiState).users as UserSearchParams;
              });
              break;
          }
        },
        setModelsSearchParams: (params) =>
          set((state) => {
            state.models = params;
          }),
        setImagesSearchParams: (params) =>
          set((state) => {
            state.images = params;
          }),
        setArticleSearchParams: (params) =>
          set((state) => {
            state.articles = params;
          }),
        setUserSearchParams: (params) =>
          set((state) => {
            state.users = params;
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
        const pattern = /\/search\/([^\/]+)/;
        const match = location.pathname.match(pattern);

        if (!match) {
          // This means the user was redirected or a new URL was likely pushed.
          return location.href;
        }

        let query = '';

        if (routeState.models) {
          query = QS.stringify(routeState.models);
        }
        if (routeState.articles) {
          query = QS.stringify(routeState.articles);
        }
        if (routeState.images) {
          query = QS.stringify(routeState.images);
        }
        if (routeState.users) {
          query = QS.stringify(routeState.users);
        }

        // Needs to be absolute url, otherwise instantsearch complains
        return `${location.origin}${location.pathname}?${query}`;
      },
      parseURL({ location }) {
        const pattern = /\/search\/([^\/]+)/;
        const match = location.pathname.match(pattern);

        if (match) {
          const index = match[1] as SearchIndex;

          return getRoutingForIndex(index).parseURL({ location });
        }

        return { '': {} };
      },
    },
  }),
  stateMapping: {
    routeToState(routeState) {
      if (routeState.models) {
        return getRoutingForIndex('models').routeToState(routeState);
      }
      if (routeState.images) {
        return getRoutingForIndex('images').routeToState(routeState);
      }
      if (routeState.articles) {
        return getRoutingForIndex('articles').routeToState(routeState);
      }
      if (routeState.users) {
        return getRoutingForIndex('users').routeToState(routeState);
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
