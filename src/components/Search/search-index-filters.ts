import type { SearchIndexKey } from '~/components/Search/search.types';

export type BrowsingLevelAttribute = 'nsfwLevel' | 'combinedNsfwLevel';

// An attribute the index doesn't declare filterable makes Meilisearch reject the whole query with
// a 400, so `tools` and `users` are omitted deliberately — their indexes have no browsing level.
// __tests__/search-index-contract.test.ts holds this against the index definitions.
export const BROWSING_LEVEL_ATTRIBUTE: Partial<Record<SearchIndexKey, BrowsingLevelAttribute>> = {
  models: 'nsfwLevel',
  images: 'nsfwLevel',
  articles: 'nsfwLevel',
  collections: 'nsfwLevel',
  bounties: 'nsfwLevel',
  comics: 'nsfwLevel',
};
