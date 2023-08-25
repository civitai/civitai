import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';

export const CollectionsSearchIndexSortBy = [
  COLLECTIONS_SEARCH_INDEX,
  `${COLLECTIONS_SEARCH_INDEX}:metrics.followersCount:desc`,
  `${COLLECTIONS_SEARCH_INDEX}:metrics.itemCount:desc`,
  `${COLLECTIONS_SEARCH_INDEX}:createdAt:desc`,
] as const;

const defaultSortBy = CollectionsSearchIndexSortBy[0];

const collectionSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('collections'),
    sortBy: z.enum(CollectionsSearchIndexSortBy),
    users: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    type: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export type CollectionSearchParams = z.output<typeof collectionSearchParamsSchema>;

export const collectionsInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const collectionSearchIndexResult = collectionSearchParamsSchema.safeParse(
      QS.parse(location.search)
    );
    const collectionSearchIndexData: CollectionSearchParams | Record<string, string[]> =
      collectionSearchIndexResult.success ? collectionSearchIndexResult.data : {};

    return { [COLLECTIONS_SEARCH_INDEX]: removeEmpty(collectionSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const collections: CollectionSearchParams = (routeState[COLLECTIONS_SEARCH_INDEX] ||
      {}) as CollectionSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      type: collections.type,
      'user.username': collections.users,
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
