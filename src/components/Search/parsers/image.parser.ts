import { UiState } from 'instantsearch.js';
import { z } from 'zod';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';
import { InstantSearchRoutingParser, searchParamsSchema } from './base';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';

export const ImagesSearchIndexSortBy = [
  IMAGES_SEARCH_INDEX,
  `${IMAGES_SEARCH_INDEX}:rank.reactionCountAllTimeRank:asc`,
  `${IMAGES_SEARCH_INDEX}:rank.commentCountAllTimeRank:asc`,
  `${IMAGES_SEARCH_INDEX}:rank.collectedCountAllTimeRank:asc`,
  `${IMAGES_SEARCH_INDEX}:createdAt:desc`,
] as const;

const defaultSortBy = ImagesSearchIndexSortBy[0];

const imageSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('images'),
    sortBy: z.enum(ImagesSearchIndexSortBy),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    users: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export type ImageSearchParams = z.output<typeof imageSearchParamsSchema>;

export const imagesInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const imageSearchIndexResult = imageSearchParamsSchema.safeParse(QS.parse(location.search));
    const imageSearchIndexData: ImageSearchParams | Record<string, string[]> =
      imageSearchIndexResult.success ? imageSearchIndexResult.data : {};

    return { [IMAGES_SEARCH_INDEX]: removeEmpty(imageSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const images: ImageSearchParams = (routeState[IMAGES_SEARCH_INDEX] || {}) as ImageSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'tags.name': images.tags,
      'user.username': images.users,
    });

    const { query, sortBy } = images;

    return {
      [IMAGES_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const tags = uiState[IMAGES_SEARCH_INDEX].refinementList?.['tags.name'];
    const users = uiState[IMAGES_SEARCH_INDEX].refinementList?.['user.username'];
    const sortBy =
      (uiState[IMAGES_SEARCH_INDEX].sortBy as ImageSearchParams['sortBy']) || defaultSortBy;

    const { query } = uiState[IMAGES_SEARCH_INDEX];

    const state: ImageSearchParams = {
      tags,
      users,
      sortBy,
      query,
    };

    return { [IMAGES_SEARCH_INDEX]: state };
  },
};
