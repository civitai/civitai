import { UiState } from 'instantsearch.js';
import { z } from 'zod';
import {
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
} from '~/server/common/constants';

const searchIndexes = [
  MODELS_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
] as const;
export type SearchIndex = (typeof searchIndexes)[number];

export const searchParamsSchema = z.object({
  query: z.coerce.string().optional(),
  page: z.coerce.number().optional(),
});

export type InstantSearchRoutingParser = {
  parseURL: (params: { location: Location }) => UiState;
  routeToState: (routeState: UiState) => UiState;
  stateToRoute: (routeState: UiState) => UiState;
};
