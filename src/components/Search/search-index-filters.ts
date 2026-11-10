import type { SearchIndexKey } from '~/components/Search/search.types';

export type BrowsingLevelAttribute = 'nsfwLevel';

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

/**
 * How an index's browsing-level attribute is matched. 'any' (the default): an item matches when any
 * of its levels is allowed, as each index's feed matches. 'subset': only when every one of its
 * levels is allowed, as the comics feed lists comics (whose level combines their chapters'); an
 * unrated item is left out.
 */
export type BrowsingLevelMatch = 'any' | 'subset';
export const BROWSING_LEVEL_MATCH: Partial<Record<SearchIndexKey, BrowsingLevelMatch>> = {
  comics: 'subset',
};
