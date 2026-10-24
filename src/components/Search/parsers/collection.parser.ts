import type { InstantSearchRoutingParser } from '~/components/Search/parsers/base';
import {
  parseSearchParams,
  searchParamsSchema,
  stringArrayParamSchema,
} from '~/components/Search/parsers/base';
import * as z from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import type { UiState } from 'instantsearch.js';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';

export const CollectionsSearchIndexSortBy = [
  COLLECTIONS_SEARCH_INDEX,
  `${COLLECTIONS_SEARCH_INDEX}:metrics.followerCount:desc`,
  `${COLLECTIONS_SEARCH_INDEX}:metrics.itemCount:desc`,
  `${COLLECTIONS_SEARCH_INDEX}:createdAt:desc`,
] as const;

const defaultSortBy = CollectionsSearchIndexSortBy[0];

const collectionSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('collections'),
    sortBy: z.enum(CollectionsSearchIndexSortBy),
    users: stringArrayParamSchema,
    type: stringArrayParamSchema,
  })
  .partial();

export type CollectionSearchParams = z.output<typeof collectionSearchParamsSchema>;

export const collectionsInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const collectionSearchIndexData = parseSearchParams(
      collectionSearchParamsSchema,
      QS.parse(location.search)
    );

    return { [COLLECTIONS_SEARCH_INDEX]: removeEmpty(collectionSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const collections: CollectionSearchParams = (routeState[COLLECTIONS_SEARCH_INDEX] ||
      {}) as CollectionSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      type: collections.type as string[],
      'user.username': collections.users as string[],
    });
    const { query, sortBy } = collections;

    return {
      [COLLECTIONS_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const type = uiState[COLLECTIONS_SEARCH_INDEX].refinementList?.['type'];
    const users = uiState[COLLECTIONS_SEARCH_INDEX].refinementList?.['user.username'];
    const sortBy =
      (uiState[COLLECTIONS_SEARCH_INDEX].sortBy as CollectionSearchParams['sortBy']) ||
      defaultSortBy;

    const { query } = uiState[COLLECTIONS_SEARCH_INDEX];

    const state: CollectionSearchParams = {
      type,
      users,
      sortBy,
      query,
    };

    return {
      [COLLECTIONS_SEARCH_INDEX]: state,
    };
  },
};
