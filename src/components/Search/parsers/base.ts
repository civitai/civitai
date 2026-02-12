import type { UiState } from 'instantsearch.js';
import * as z from 'zod';
import {
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
} from '~/server/common/constants';

const searchIndexes = [
  MODELS_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
] as const;
export type SearchIndex = (typeof searchIndexes)[number];
export const SearchIndexEntityTypes = {
  [MODELS_SEARCH_INDEX]: 'Model',
  [ARTICLES_SEARCH_INDEX]: 'Article',
  [USERS_SEARCH_INDEX]: 'User',
  [IMAGES_SEARCH_INDEX]: 'Image',
  [COLLECTIONS_SEARCH_INDEX]: 'Collection',
  [BOUNTIES_SEARCH_INDEX]: 'Bounty',
  [TOOLS_SEARCH_INDEX]: 'Tool',
  [COMICS_SEARCH_INDEX]: 'Comic',
} as const;

export type SearchIndexEntityType =
  (typeof SearchIndexEntityTypes)[keyof typeof SearchIndexEntityTypes];

export const searchParamsSchema = z.object({
  query: z.coerce.string().optional(),
  page: z.coerce.number().optional(),
});

export type InstantSearchRoutingParser = {
  parseURL: (params: { location: Location }) => UiState;
  routeToState: (routeState: UiState) => UiState;
  stateToRoute: (routeState: UiState) => UiState;
};
