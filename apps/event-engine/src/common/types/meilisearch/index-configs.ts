// Meilisearch index configurations - exact definitions from search index jobs

export interface IndexConfig {
  searchableAttributes: string[];
  sortableAttributes: string[];
  filterableAttributes: string[];
  rankingRules?: string[];
}

// MODELS_SEARCH_INDEX configuration
export const MODELS_INDEX_CONFIG: IndexConfig = {
  searchableAttributes: ['name', 'user.username', 'hashes', 'triggerWords'],
  sortableAttributes: [
    'createdAt',
    'id',
    'metrics.collectedCount',
    'metrics.commentCount',
    'metrics.downloadCount',
    'metrics.thumbsUpCount',
    'metrics.tippedAmountCount',
  ],
  filterableAttributes: [
    'availability',
    'canGenerate',
    'category.name',
    'checkpointType',
    'fileFormats',
    'hashes',
    'id',
    'lastVersionAtUnix',
    'nsfwLevel',
    'status',
    'tags.name',
    'type',
    'user.id',
    'user.username',
    'version.baseModel',
    'versions.baseModel',
    'versions.hashes',
    'versions.id',
    'cannotPromote',
    'poi',
    'minor',
  ],
  rankingRules: [
    'sort',
    'attribute',
    'metrics.thumbsUpCount:desc',
    'words',
    'proximity',
    'exactness',
  ],
};

// METRICS_MODELS_SEARCH_INDEX configuration
export const METRICS_MODELS_INDEX_CONFIG: IndexConfig = {
  searchableAttributes: [], // No text search in metrics index
  sortableAttributes: [
    'id',
    'publishedAtUnix',
    'lastVersionAtUnix',
    'downloadCount',
    'favoriteCount',
    'commentCount',
    'ratingCount',
    'rating',
  ],
  filterableAttributes: [
    'id',
    'userId',
    'type',
    'status',
    'checkpointType',
    'baseModel',
    'tagIds',
    'nsfwLevel',
    'poi',
    'minor',
    'earlyAccess',
    'supportsGeneration',
    'fromPlatform',
    'availability',
    'publishedAtUnix',
    'lastVersionAtUnix',
    'collectionId',
    'clubId',
    'fileFormats',
    'isFeatured',
  ],
  rankingRules: ['sort'],
};

// IMAGES_SEARCH_INDEX configuration
export const IMAGES_INDEX_CONFIG: IndexConfig = {
  searchableAttributes: ['prompt', 'tagNames', 'user.username'],
  sortableAttributes: [
    'id',
    'sortAt',
    'stats.commentCountAllTime',
    'stats.reactionCountAllTime',
    'stats.collectedCountAllTime',
    'stats.tippedAmountCountAllTime',
  ],
  filterableAttributes: [
    'id',
    'createdAtUnix',
    'tagNames',
    'user.username',
    'baseModel',
    'aspectRatio',
    'nsfwLevel',
    'combinedNsfwLevel',
    'type',
    'toolNames',
    'techniqueNames',
    'flags.promptNsfw',
    'poi',
    'minor',
  ],
};

// METRICS_IMAGES_SEARCH_INDEX configuration
export const METRICS_IMAGES_INDEX_CONFIG: IndexConfig = {
  searchableAttributes: [], // No text search in metrics index
  sortableAttributes: [
    'id',
    'sortAt',
    'reactionCount',
    'commentCount',
    'collectedCount',
  ],
  filterableAttributes: [
    'id',
    'sortAtUnix',
    'modelVersionIds',
    'modelVersionIdsManual',
    'postedToId',
    'baseModel',
    'type',
    'hasMeta',
    'onSite',
    'toolIds',
    'techniqueIds',
    'tagIds',
    'userId',
    'nsfwLevel',
    'combinedNsfwLevel',
    'postId',
    'publishedAtUnix',
    'existedAtUnix',
    'flags.promptNsfw',
    'remixOfId',
    'availability',
    'poi',
    'minor',
    'blockedFor',
  ],
  rankingRules: ['sort'],
};

// Index name constants
export const INDEX_NAMES = {
  MODELS: 'feeds_models_v1',
  IMAGES: 'metrics_images_v1',
} as const;

export type IndexName = typeof INDEX_NAMES[keyof typeof INDEX_NAMES];
