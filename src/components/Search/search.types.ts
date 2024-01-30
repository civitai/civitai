import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';

// #region [search index maps]
export type SearchIndexKey = keyof typeof searchIndexMap;
export const searchIndexMap = {
  models: MODELS_SEARCH_INDEX,
  images: IMAGES_SEARCH_INDEX,
  articles: ARTICLES_SEARCH_INDEX,
  users: USERS_SEARCH_INDEX,
  collections: COLLECTIONS_SEARCH_INDEX,
  bounties: BOUNTIES_SEARCH_INDEX,
} as const;

export type ReverseSearchIndexKey = keyof typeof reverseSearchIndexMap;
export const reverseSearchIndexMap = {
  [MODELS_SEARCH_INDEX]: 'models',
  [IMAGES_SEARCH_INDEX]: 'images',
  [ARTICLES_SEARCH_INDEX]: 'articles',
  [USERS_SEARCH_INDEX]: 'users',
  [COLLECTIONS_SEARCH_INDEX]: 'collections',
  [BOUNTIES_SEARCH_INDEX]: 'bounties',
} as const;
// #endregion

export const searchIndexProps: Record<SearchIndexKey, { label: string }> = {
  models: { label: 'Models' },
  images: { label: 'Images' },
  articles: { label: 'Articles' },
  users: { label: 'Users' },
  collections: { label: 'Collections' },
  bounties: { label: 'Bounties' },
} as const;
