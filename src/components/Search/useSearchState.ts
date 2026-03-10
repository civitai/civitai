import { QS } from '~/utils/qs';
import type { UiState } from 'instantsearch.js';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import singletonRouter from 'next/router';
import type { InstantSearchProps } from 'react-instantsearch';
import { createInstantSearchRouterNext } from 'react-instantsearch-router-nextjs';
import type { InstantSearchRoutingParser, SearchIndex } from './parsers/base';
import type { ImageSearchParams } from './parsers/image.parser';
import { imagesInstantSearchRoutingParser } from './parsers/image.parser';
import type { ModelSearchParams } from '~/components/Search/parsers/model.parser';
import { modelInstantSearchRoutingParser } from '~/components/Search/parsers/model.parser';
import type { ArticleSearchParams } from '~/components/Search/parsers/article.parser';
import { articlesInstantSearchRoutingParser } from '~/components/Search/parsers/article.parser';
import type { UserSearchParams } from '~/components/Search/parsers/user.parser';
import { usersInstantSearchRoutingParser } from '~/components/Search/parsers/user.parser';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
} from '~/server/common/constants';
import type { CollectionSearchParams } from '~/components/Search/parsers/collection.parser';
import { collectionsInstantSearchRoutingParser } from '~/components/Search/parsers/collection.parser';
import type { BountySearchParams } from '~/components/Search/parsers/bounties.parser';
import { bountiesInstantSearchRoutingParser } from '~/components/Search/parsers/bounties.parser';
import { searchIndexMap } from '~/components/Search/search.types';
import type { ToolSearchParams } from '~/components/Search/parsers/tool.parser';
import { toolsInstantSearchRoutingParser } from '~/components/Search/parsers/tool.parser';
import type { ComicSearchParams } from '~/components/Search/parsers/comic.parser';
import { comicsInstantSearchRoutingParser } from '~/components/Search/parsers/comic.parser';

type StoreState = {
  models: ModelSearchParams;
  images: ImageSearchParams;
  articles: ArticleSearchParams;
  users: UserSearchParams;
  collections: CollectionSearchParams;
  bounties: BountySearchParams;
  tools: ToolSearchParams;
  comics: ComicSearchParams;
  setSearchParamsByUiState: (uiState: UiState) => void;
  setModelsSearchParams: (filters: Partial<ModelSearchParams>) => void;
  setImagesSearchParams: (filters: Partial<ImageSearchParams>) => void;
  setArticleSearchParams: (filters: Partial<ArticleSearchParams>) => void;
  setUserSearchParams: (filters: Partial<UserSearchParams>) => void;
  setCollectionSearchParams: (filters: Partial<CollectionSearchParams>) => void;
  setBountiesSearchParams: (filters: Partial<BountySearchParams>) => void;
  setToolsSearchParams: (filters: Partial<ToolSearchParams>) => void;
  setComicsSearchParams: (filters: Partial<ComicSearchParams>) => void;
};

export const IndexToLabel = {
  [MODELS_SEARCH_INDEX]: 'Models',
  [IMAGES_SEARCH_INDEX]: 'Images',
  [ARTICLES_SEARCH_INDEX]: 'Articles',
  [USERS_SEARCH_INDEX]: 'Users',
  [COLLECTIONS_SEARCH_INDEX]: 'Collections',
  [BOUNTIES_SEARCH_INDEX]: 'Bounties',
  [TOOLS_SEARCH_INDEX]: 'Tools',
  [COMICS_SEARCH_INDEX]: 'Comics',
} as const;

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
    case COLLECTIONS_SEARCH_INDEX:
      return collectionsInstantSearchRoutingParser;
    case BOUNTIES_SEARCH_INDEX:
      return bountiesInstantSearchRoutingParser;
    case TOOLS_SEARCH_INDEX:
      return toolsInstantSearchRoutingParser;
    case COMICS_SEARCH_INDEX:
      return comicsInstantSearchRoutingParser;
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
        collections: {},
        bounties: {},
        tools: {},
        comics: {},
        // methods
        setSearchParamsByUiState: (uiState: UiState) => {
          const [index] = Object.keys(uiState);

          if (!index) {
            return;
          }

          const routing = getRoutingForIndex(index as SearchIndex);

          switch (index) {
            case ARTICLES_SEARCH_INDEX:
              set((state) => {
                state.articles = routing.stateToRoute(uiState)[
                  ARTICLES_SEARCH_INDEX
                ] as ArticleSearchParams;
              });
              break;
            case MODELS_SEARCH_INDEX:
              set((state) => {
                state.models = routing.stateToRoute(uiState)[
                  MODELS_SEARCH_INDEX
                ] as ModelSearchParams;
              });
              break;
            case IMAGES_SEARCH_INDEX:
              set((state) => {
                state.images = routing.stateToRoute(uiState)[
                  IMAGES_SEARCH_INDEX
                ] as ImageSearchParams;
              });
              break;
            case USERS_SEARCH_INDEX:
              set((state) => {
                state.users = routing.stateToRoute(uiState)[USERS_SEARCH_INDEX] as UserSearchParams;
              });
              break;
            case COLLECTIONS_SEARCH_INDEX:
              set((state) => {
                state.collections = routing.stateToRoute(uiState)[
                  COLLECTIONS_SEARCH_INDEX
                ] as CollectionSearchParams;
              });
              break;
            case BOUNTIES_SEARCH_INDEX:
              set((state) => {
                state.bounties = routing.stateToRoute(uiState)[
                  BOUNTIES_SEARCH_INDEX
                ] as BountySearchParams;
              });
              break;
            case TOOLS_SEARCH_INDEX:
              set((state) => {
                state.tools = routing.stateToRoute(uiState)[TOOLS_SEARCH_INDEX] as ToolSearchParams;
              });
              break;
            case COMICS_SEARCH_INDEX:
              set((state) => {
                state.comics = routing.stateToRoute(uiState)[
                  COMICS_SEARCH_INDEX
                ] as ComicSearchParams;
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
        setCollectionSearchParams: (params) =>
          set((state) => {
            state.collections = params;
          }),
        setBountiesSearchParams: (params) =>
          set((state) => {
            state.bounties = params;
          }),
        setToolsSearchParams: (params) =>
          set((state) => {
            state.tools = params;
          }),
        setComicsSearchParams: (params) =>
          set((state) => {
            state.comics = params;
          }),
      };
    })
  )
);

export const routing: InstantSearchProps['routing'] = {
  router: createInstantSearchRouterNext({
    singletonRouter,
    routerOptions: {
      cleanUrlOnDispose: false,
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
        } else if (routeState[COLLECTIONS_SEARCH_INDEX]) {
          query = QS.stringify(routeState[COLLECTIONS_SEARCH_INDEX]);
        } else if (routeState[BOUNTIES_SEARCH_INDEX]) {
          query = QS.stringify(routeState[BOUNTIES_SEARCH_INDEX]);
        } else if (routeState[TOOLS_SEARCH_INDEX]) {
          query = QS.stringify(routeState[TOOLS_SEARCH_INDEX]);
        } else if (routeState[COMICS_SEARCH_INDEX]) {
          query = QS.stringify(routeState[COMICS_SEARCH_INDEX]);
        }

        // Needs to be absolute url, otherwise instantsearch complains
        return `${location.origin}${location.pathname}?${query}`;
      },
      parseURL({ location }) {
        const pattern = /\/search\/([^\/]+)/;
        const match = location.pathname.match(pattern);

        if (match) {
          const key = match[1] as keyof typeof searchIndexMap;

          if (searchIndexMap.hasOwnProperty(key)) {
            const index = searchIndexMap[key] as SearchIndex;

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
      if (routeState[COLLECTIONS_SEARCH_INDEX]) {
        return getRoutingForIndex(COLLECTIONS_SEARCH_INDEX).routeToState(routeState);
      }
      if (routeState[BOUNTIES_SEARCH_INDEX]) {
        return getRoutingForIndex(BOUNTIES_SEARCH_INDEX).routeToState(routeState);
      }
      if (routeState[TOOLS_SEARCH_INDEX]) {
        return getRoutingForIndex(TOOLS_SEARCH_INDEX).routeToState(routeState);
      }
      if (routeState[COMICS_SEARCH_INDEX]) {
        return getRoutingForIndex(COMICS_SEARCH_INDEX).routeToState(routeState);
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
