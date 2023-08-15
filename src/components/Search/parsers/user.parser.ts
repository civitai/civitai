import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';

export const UsersSearchIndexSortBy = [
  'users:stats.followerCountAllTime:desc',
  'users:stats.weightedRating:desc',
  'users:stats.uploadCountAllTime:desc',
  'users:createdAt:desc',
] as const;

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

    return { users: removeEmpty(userSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const users: UserSearchParams = (routeState.users || {}) as UserSearchParams;
    const { query, sortBy } = users;

    return {
      users: {
        sortBy: sortBy ?? 'users:stats.followerCountAllTime:desc',
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const sortBy =
      (uiState.users.sortBy as UserSearchParams['sortBy']) ||
      'users:stats.followerCountAllTime:desc';

    const { query } = uiState.users;

    const state: UserSearchParams = {
      sortBy,
      query,
    };

    return {
      users: state,
    };
  },
};
