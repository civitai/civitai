// Feed input types - parameters for feed functions

// Base feed input
export interface BaseFeedInput {
  take?: number;
  offset?: number;
  cursor?: string | number | bigint | Date | undefined;
}

// Model feed input (based on getModelsRaw parameters)
export interface ModelFeedInput extends BaseFeedInput {
  user?: number;
  query?: string;
  tag?: string;
  tagname?: string;
  username?: string;
  baseModels?: string[];
  types?: string[];
  sort?: string;
  period?: string;
  periodMode?: string;
  hidden?: boolean;
  checkpointType?: string;
  status?: string[];
  allowNoCredit?: boolean;
  allowDifferentLicense?: boolean;
  allowDerivatives?: boolean;
  allowCommercialUse?: string[];
  ids?: number[];
  earlyAccess?: boolean;
  supportsGeneration?: boolean;
  fromPlatform?: boolean;
  needsReview?: boolean;
  collectionId?: number;
  fileFormats?: string[];
  clubId?: number;
  modelVersionIds?: number[];
  browsingLevel?: number;
  excludedUserIds?: number[];
  excludedTagIds?: number[];
  collectionTagId?: number;
  availability?: string[];
  disablePoi?: boolean;
  disableMinor?: boolean;
  isFeatured?: boolean;
  poiOnly?: boolean;
  minorOnly?: boolean;
  followed?: boolean;
  archived?: boolean;
  pending?: boolean;
}

// Image feed input (based on getImagesFromSearchPreFilter parameters)
export interface ImageFeedInput extends BaseFeedInput {
  sort?: string;
  modelVersionId?: number;
  types?: string[];
  withMeta?: boolean;
  fromPlatform?: boolean;
  notPublished?: boolean;
  scheduled?: boolean;
  username?: string;
  tags?: number[];
  tools?: number[];
  techniques?: number[];
  baseModels?: string[];
  period?: string;
  isModerator?: boolean;
  currentUserId?: number;
  excludedUserIds?: number[];
  hideAutoResources?: boolean;
  hideManualResources?: boolean;
  hidden?: boolean;
  followed?: boolean;
  limit?: number;
  entry?: number;
  postId?: number;
  reviewId?: number;
  modelId?: number;
  prioritizedUserIds?: number[];
  useCombinedNsfwLevel?: boolean;
  remixOfId?: number;
  remixesOnly?: boolean;
  nonRemixesOnly?: boolean;
  excludedTagIds?: number[];
  disablePoi?: boolean;
  disableMinor?: boolean;
  requiringMeta?: boolean;
  poiOnly?: boolean;
  minorOnly?: boolean;
  blockedFor?: string[];
  useLogicalReplica?: boolean;
  browsingLevel?: number;
  userId?: number;
  postIds?: number[];
  nsfwRestrictedBaseModels?: string[];
}

// Feed options for Meilisearch queries
export interface FeedOptions {
  offset?: number;
  limit?: number;
  filter?: string[];
  sort?: string[];
  attributesToRetrieve?: string[];
  attributesToCrop?: string[];
  attributesToHighlight?: string[];
  cropLength?: number;
  highlightPreTag?: string;
  highlightPostTag?: string;
  showMatchesPosition?: boolean;
  facets?: string[];
  q?: string;
}

// Sort options
export interface SortOption {
  field: string;
  direction: 'asc' | 'desc';
}

// Common sort mappings
export const MODEL_SORT_OPTIONS: Record<string, SortOption> = {
  Newest: { field: 'publishedAtUnix', direction: 'desc' },
  Oldest: { field: 'publishedAtUnix', direction: 'asc' },
  'Most Downloaded': { field: 'downloadCount', direction: 'desc' },
  'Highest Rated': { field: 'rating', direction: 'desc' },
  'Most Liked': { field: 'thumbsUpCount', direction: 'desc' },
  'Most Discussed': { field: 'commentCount', direction: 'desc' },
  'Most Collected': { field: 'collectedCount', direction: 'desc' },
  'Most Tipped': { field: 'tippedAmountCount', direction: 'desc' },
};

export const IMAGE_SORT_OPTIONS: Record<string, SortOption> = {
  Newest: { field: 'sortAtUnix', direction: 'desc' },
  Oldest: { field: 'sortAtUnix', direction: 'asc' },
  'Most Reactions': { field: 'reactionCount', direction: 'desc' },
  'Most Comments': { field: 'commentCount', direction: 'desc' },
  'Most Collected': { field: 'collectedCount', direction: 'desc' },
};
