import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';

// Kept a leaf so a test can read these without loading `~/server/meilisearch/client`, which builds
// pLimit/prom collectors at module load. Same reasoning as ./filterable-attributes.ts.

// 🔴 These lists are only ever WRITTEN to a live index by each index's `onIndexSetup`, and
// `onIndexSetup` runs in exactly one place: `reset()` in ./base.search-index.ts, against the
// `<index>_NEW` swap index. Every `search-index-sync-<name>-reset` job is registered with
// `UNRUNNABLE_JOB_CRON`, i.e. it is manual-only and can go years between runs.
//
// So editing a list here does NOT change what a live index accepts. Adding an entry is safe (it
// takes effect whenever a reset next happens). REMOVING or RENAMING one is a migration: the client
// must keep sorting on the old attribute until a reset has actually shipped, otherwise every search
// using that sort answers `Attribute ... is not sortable` and the results page fails outright.
// The sort options the client may request live in src/components/Search/parsers/*.parser.ts and are
// pinned against these lists by src/components/Search/__tests__/search-index-contract.test.ts.

// `id` is sortable on every index because the keyset cleanup scan in
// src/server/meilisearch/cleanup.ts pages on it.
export const articlesSortableAttributes = [
  'createdAt',
  'id',
  'stats.commentCount',
  'stats.favoriteCount',
  'stats.collectedCount',
  'stats.viewCount',
  'stats.tippedAmountCount',
];

export const bountiesSortableAttributes = [
  'createdAt',
  'id',
  // The bounties sort options ask for a bare `favoriteCountAllTime`, while the document only
  // carries it as `stats.favoriteCountAllTime`. Declared so the option cannot answer
  // `Attribute ... is not sortable`; re-pointing the option at the `stats.` spelling is a
  // behaviour change and is tracked separately.
  'favoriteCountAllTime',
  'stats.unitAmountCountAllTime',
  'stats.entryCountAllTime',
  'stats.favoriteCountAllTime',
];

export const collectionsSortableAttributes = [
  'createdAt',
  'id',
  'metrics.itemCount',
  'metrics.followerCount',
  'metrics.contributorCount',
];

export const comicsSortableAttributes = [
  'createdAt',
  'id',
  'updatedAt',
  'stats.chapterCount',
  'stats.followerCount',
];

export const imagesSortableAttributes = [
  'createdAt',
  'id',
  'sortAt',
  'stats.commentCountAllTime',
  'stats.reactionCountAllTime',
  'stats.collectedCountAllTime',
  'stats.tippedAmountCountAllTime',
];

export const modelsSortableAttributes = [
  'createdAt',
  'id',
  'metrics.collectedCount',
  'metrics.commentCount',
  'metrics.downloadCount',
  'metrics.favoriteCount',
  'metrics.thumbsUpCount',
  'metrics.tippedAmountCount',
];

export const toolsSortableAttributes = ['createdAt', 'id', 'name'];

export const usersSortableAttributes = [
  'createdAt',
  'id',
  'metrics.thumbsUpCount',
  'metrics.followerCount',
  'metrics.uploadCount',
];

export const sortableAttributesByIndex = {
  [ARTICLES_SEARCH_INDEX]: articlesSortableAttributes,
  [BOUNTIES_SEARCH_INDEX]: bountiesSortableAttributes,
  [COLLECTIONS_SEARCH_INDEX]: collectionsSortableAttributes,
  [COMICS_SEARCH_INDEX]: comicsSortableAttributes,
  [IMAGES_SEARCH_INDEX]: imagesSortableAttributes,
  [MODELS_SEARCH_INDEX]: modelsSortableAttributes,
  [TOOLS_SEARCH_INDEX]: toolsSortableAttributes,
  [USERS_SEARCH_INDEX]: usersSortableAttributes,
} as const;
