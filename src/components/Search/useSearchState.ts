import { QS } from '~/utils/qs';
import type { UiState } from 'instantsearch.js';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import singletonRouter from 'next/router';
import { InstantSearchProps } from 'react-instantsearch';
import { createInstantSearchRouterNext } from 'react-instantsearch-router-nextjs';
import { InstantSearchRoutingParser, SearchIndex } from './parsers/base';
import { ImageSearchParams, imagesInstantSearchRoutingParser } from './parsers/image.parser';
import {
  modelInstantSearchRoutingParser,
  ModelSearchParams,
} from '~/components/Search/parsers/model.parser';
import {
  ArticleSearchParams,
  articlesInstantSearchRoutingParser,
} from '~/components/Search/parsers/article.parser';
import {
  UserSearchParams,
  usersInstantSearchRoutingParser,
} from '~/components/Search/parsers/user.parser';
import {
  ARTICLES_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';

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

export const SearchPathToIndexMap = {
  ['models']: MODELS_SEARCH_INDEX,
  ['images']: IMAGES_SEARCH_INDEX,
  ['articles']: ARTICLES_SEARCH_INDEX,
  ['users']: USERS_SEARCH_INDEX,
};

export const IndexToLabel = {
  [MODELS_SEARCH_INDEX]: 'Models',
  [IMAGES_SEARCH_INDEX]: 'Images',
  [ARTICLES_SEARCH_INDEX]: 'Articles',
  [USERS_SEARCH_INDEX]: 'Users',
};

export const getRoutingForIndex = (index: SearchIndex): InstantSearchRoutingParser => {
  switch (index) {
    case MODELS_SEARCH_INDEX:
      return modelInstantSearchRoutingParser;
    case IMAGES_SEARCH_INDEX:
      return imagesInstantSearchRoutingParser;
    case ARTICLES_SEARCH_INDEX:
      return articlesInstantSearchRoutingParser;
    case USERS_SEARCH_INDEX:
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
    beforePopState: ({ state, ownBeforePopState, libraryBeforePopState }) => {
      console.log('routing :: beforePopState', state);

      return ownBeforePopState(state) && libraryBeforePopState(state);
    },
    routerOptions: {
      createURL({ routeState, location }) {
        const pattern = /\/search\/([^\/]+)/;
        const match = location.pathname.match(pattern);

        if (!match) {
          // This means the user was redirected or a new URL was likely pushed.
          return location.href;
        }

        let query = '';

        if (routeState[MODELS_SEARCH_INDEX]) {
          query = QS.stringify(routeState[MODELS_SEARCH_INDEX]);
        } else if (routeState[ARTICLES_SEARCH_INDEX]) {
          query = QS.stringify(routeState[ARTICLES_SEARCH_INDEX]);
        } else if (routeState[IMAGES_SEARCH_INDEX]) {
          query = QS.stringify(routeState[IMAGES_SEARCH_INDEX]);
        } else if (routeState[USERS_SEARCH_INDEX]) {
          query = QS.stringify(routeState[USERS_SEARCH_INDEX]);
        }

        // Needs to be absolute url, otherwise instantsearch complains
        return `${location.origin}${location.pathname}?${query}`;
      },
      parseURL({ location }) {
        const pattern = /\/search\/([^\/]+)/;
        const match = location.pathname.match(pattern);

        if (match) {
          const key = match[1] as keyof typeof SearchPathToIndexMap;

          if (SearchPathToIndexMap.hasOwnProperty(key)) {
            const index = SearchPathToIndexMap[key] as SearchIndex;

            return getRoutingForIndex(index).parseURL({ location });
          }
        }

        // If no index can be matched from the URL, a default empty state will be returned to
        // instantsearch.
        return { '': {} };
      },
    },
  }),
  stateMapping: {
    routeToState(routeState) {
      if (routeState[MODELS_SEARCH_INDEX]) {
        return getRoutingForIndex(MODELS_SEARCH_INDEX).routeToState(routeState);
      }
      if (routeState[IMAGES_SEARCH_INDEX]) {
        return getRoutingForIndex(IMAGES_SEARCH_INDEX).routeToState(routeState);
      }
      if (routeState[ARTICLES_SEARCH_INDEX]) {
        return getRoutingForIndex(ARTICLES_SEARCH_INDEX).routeToState(routeState);
      }
      if (routeState[USERS_SEARCH_INDEX]) {
        return getRoutingForIndex(USERS_SEARCH_INDEX).routeToState(routeState);
      }

      return routeState;
    },
    stateToRoute(uiState) {
      const [index] = Object.keys(uiState);
      const routing = getRoutingForIndex(index ? (index as SearchIndex) : MODELS_SEARCH_INDEX);
      return routing.stateToRoute(uiState);
    },
  },
};
