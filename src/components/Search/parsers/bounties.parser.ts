import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';
import { BOUNTIES_SEARCH_INDEX } from '~/server/common/constants';

export const BountiesSearchIndexSortBy = [
  BOUNTIES_SEARCH_INDEX,
  `${BOUNTIES_SEARCH_INDEX}:stats.unitAmountCountAllTime:desc`,
  `${BOUNTIES_SEARCH_INDEX}:stats.entryCountAllTime:desc`,
  `${BOUNTIES_SEARCH_INDEX}:favoriteCountAllTime:desc`,
  `${BOUNTIES_SEARCH_INDEX}:createdAt`,
] as const;

const defaultSortBy = BountiesSearchIndexSortBy[0];

const collectionSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('bounties'),
    sortBy: z.enum(BountiesSearchIndexSortBy),
    baseModel: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    users: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    type: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export type BountySearchParams = z.output<typeof collectionSearchParamsSchema>;

export const bountiesInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const collectionSearchIndexResult = collectionSearchParamsSchema.safeParse(
      QS.parse(location.search)
    );
    const collectionSearchIndexData: BountySearchParams | Record<string, string[]> =
      collectionSearchIndexResult.success ? collectionSearchIndexResult.data : {};

    return { [BOUNTIES_SEARCH_INDEX]: removeEmpty(collectionSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const bounties: BountySearchParams = (routeState[BOUNTIES_SEARCH_INDEX] ||
      {}) as BountySearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'details.baseModel': bounties.baseModel,
      type: bounties.type,
      'tags.name': bounties.tags,
      'user.username': bounties.users,
    });
    const { query, sortBy } = bounties;

    return {
      [BOUNTIES_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const baseModel = uiState[BOUNTIES_SEARCH_INDEX].refinementList?.['details.baseModel'];
    const type = uiState[BOUNTIES_SEARCH_INDEX].refinementList?.['type'];
    const users = uiState[BOUNTIES_SEARCH_INDEX].refinementList?.['user.username'];
    const tags = uiState[BOUNTIES_SEARCH_INDEX].refinementList?.['tags.name'];
    const sortBy =
      (uiState[BOUNTIES_SEARCH_INDEX].sortBy as BountySearchParams['sortBy']) || defaultSortBy;

    const { query } = uiState[BOUNTIES_SEARCH_INDEX];

    const state: BountySearchParams = {
      baseModel,
      type,
      tags,
      users,
      sortBy,
      query,
    };

    return {
      [BOUNTIES_SEARCH_INDEX]: state,
    };
  },
};
