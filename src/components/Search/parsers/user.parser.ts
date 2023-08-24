import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';
import { USERS_SEARCH_INDEX } from '~/server/common/constants';

export const UsersSearchIndexSortBy = [
  USERS_SEARCH_INDEX,
  `${USERS_SEARCH_INDEX}:stats.followerCountAllTime:desc`,
  `${USERS_SEARCH_INDEX}:stats.weightedRating:desc`,
  `${USERS_SEARCH_INDEX}:stats.uploadCountAllTime:desc`,
  `${USERS_SEARCH_INDEX}:createdAt:desc`,
] as const;

const defaultSortBy = UsersSearchIndexSortBy[0];

const userSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('users'),
    sortBy: z.enum(UsersSearchIndexSortBy),
  })
  .partial();

export type UserSearchParams = z.output<typeof userSearchParamsSchema>;

export const usersInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const userSearchIndexResult = userSearchParamsSchema.safeParse(QS.parse(location.search));
    const userSearchIndexData: UserSearchParams | Record<string, string[]> =
      userSearchIndexResult.success ? userSearchIndexResult.data : {};

    return { [USERS_SEARCH_INDEX]: removeEmpty(userSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const users: UserSearchParams = (routeState[USERS_SEARCH_INDEX] || {}) as UserSearchParams;
    const { query, sortBy } = users;

    return {
      [USERS_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const sortBy =
      (uiState[USERS_SEARCH_INDEX].sortBy as UserSearchParams['sortBy']) || defaultSortBy;

    const { query } = uiState[USERS_SEARCH_INDEX];

    const state: UserSearchParams = {
      sortBy,
      query,
    };

    return {
      [USERS_SEARCH_INDEX]: state,
    };
  },
};
