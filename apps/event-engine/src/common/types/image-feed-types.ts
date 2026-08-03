/**
 * Image Feed Types
 *
 * Types and enums specific to the Image Feed
 * Ported from the main Civitai codebase for use in event-engine-common
 */

// ============================================================================
// Enums
// ============================================================================

export enum ImageSort {
  MostReactions = 'Most Reactions',
  MostComments = 'Most Comments',
  MostCollected = 'Most Collected',
  Newest = 'Newest',
  Oldest = 'Oldest',
}

export enum NsfwLevel {
  NotProcessed = 0,
  PG = 1,
  PG13 = 2,
  R = 4,
  X = 8,
  XXX = 16,
  Blocked = 32,
}

export enum Availability {
  Public = 'Public',
  Private = 'Private',
  Unsearchable = 'Unsearchable',
}

export enum BlockedReason {
  TOS = 'tos',
  Moderated = 'moderated',
  CSAM = 'CSAM',
  AiNotVerified = 'AiNotVerified',
}

export enum MediaType {
  image = 'image',
  video = 'video',
  audio = 'audio',
}

// ============================================================================
// NSFW Browsing Level Constants
// ============================================================================

export const sfwBrowsingLevelsArray: NsfwLevel[] = [NsfwLevel.PG, NsfwLevel.PG13];
export const nsfwBrowsingLevelsArray: NsfwLevel[] = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];
export const allBrowsingLevelsArray: NsfwLevel[] = [
  ...sfwBrowsingLevelsArray,
  ...nsfwBrowsingLevelsArray,
];

// Flags (bit flags for efficient storage)
export const sfwBrowsingLevelsFlag = NsfwLevel.PG | NsfwLevel.PG13;
export const nsfwBrowsingLevelsFlag = NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;
export const allBrowsingLevelsFlag = sfwBrowsingLevelsFlag | nsfwBrowsingLevelsFlag;

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Base model types that may have NSFW restrictions
 */
export type BaseModel = string; // Simplified, actual list is dynamic

/**
 * Flags object for image metadata
 */
export type ImageFlags = {
  promptNsfw?: boolean;
};

// ============================================================================
// Document Types
// ============================================================================

/**
 * Base image data fetched from PostgreSQL
 */
export type SearchBaseImage = {
  id: number;
  index: number;
  postId: number;
  url: string;
  nsfwLevel: number;
  aiNsfwLevel: number;
  nsfwLevelLocked: boolean;
  width: number;
  height: number;
  hash: string;
  hideMeta: boolean;
  sortAt: Date;
  type: string;
  userId: number;
  publishedAt?: Date;
  hasMeta: boolean;
  onSite: boolean;
  postedToId?: number;
  needsReview: string | null;
  minor?: boolean;
  promptNsfw?: boolean;
  blockedFor: BlockedReason | null;
  remixOfId?: number | null;
  hasPositivePrompt?: boolean;
  availability?: Availability;
  poi: boolean;
  acceptableMinor?: boolean;
};

/**
 * Image document as stored in Meilisearch
 * This is the complete document with all indexed fields
 */
export type ImageDocument = {
  // Primary
  id: number;
  index: number;

  // Basic fields
  sortAt: Date;
  sortAtUnix: number;
  type: string;
  userId: number;
  postId: number;
  url: string;
  width: number;
  height: number;
  hash: string;
  hideMeta: boolean;

  // Model/Resource fields
  modelVersionIds: number[];
  modelVersionIdsManual: number[];
  postedToId?: number;
  baseModel: string;

  // NSFW/Content Safety
  nsfwLevel: number;
  aiNsfwLevel: number;
  combinedNsfwLevel: number;
  availability?: Availability;
  blockedFor: BlockedReason | null;
  poi: boolean;
  minor?: boolean;
  acceptableMinor?: boolean;
  needsReview: string | null;

  // Tags/Tools/Techniques
  tagIds: number[];
  toolIds: number[];
  techniqueIds: number[];

  // Metadata
  hasMeta: boolean;
  hasPositivePrompt?: boolean;
  onSite: boolean;
  publishedAt?: Date;
  publishedAtUnix?: number;
  existedAtUnix: number;
  remixOfId?: number | null;

  // Flags
  flags?: ImageFlags;

  // Metrics
  reactionCount: number;
  commentCount: number;
  collectedCount: number;
};

/**
 * Stats object attached to populated images
 */
export type ImageStats = {
  likeCountAllTime: number;
  heartCountAllTime: number;
  laughCountAllTime: number;
  cryCountAllTime: number;
  dislikeCountAllTime: number;
  commentCountAllTime: number;
  collectedCountAllTime: number;
  tippedAmountCountAllTime: number;
  viewCountAllTime: number;
};

/**
 * User data attached to populated images
 */
export type ImageUser = {
  id: number;
  username: string;
  image: string | null;
  deletedAt: Date | null;
  profilePictureId?: number;
};

/**
 * Fully populated image with all related data
 * This is what gets returned from populateDocuments
 * Matches the output format of getAllImagesIndex
 */
export type PopulatedImage = Omit<ImageDocument, 'postedToId'> & {
  // Stats from metrics
  stats: ImageStats;

  // User data
  user: {
    id: number;
    username: string;
    image: string | null;
    deletedAt: Date | null;
    cosmetics: any[];
    profilePicture: any | null;
  };

  // Reactions (user-specific)
  reactions: Array<{
    userId: number;
    reaction: string;
  }>;

  // Cosmetic for the image itself
  cosmetic: any | null;

  // Tags
  tags: Array<{
    id: number;
    name: string;
    type: number;
    nsfwLevel: NsfwLevel;
  }>;

  // Transformed/additional fields
  modelVersionId?: number; // from postedToId
  createdAt: Date; // from sortAt
  publishedAt?: Date;
  metadata: {
    width: number;
    height: number;
    [key: string]: any; // Additional video metadata
  } | null;

  // Additional getAllImagesIndex fields
  availability: Availability;
  name: null;
  scannedAt: null;
  mimeType: null;
  ingestion: 'Scanned' | 'Blocked' | 'NotFound';
  postTitle: null;
  meta: any | null;
  thumbnailUrl?: string;
  nsfwLevel: number; // Recalculated from thumbnail
};

// ============================================================================
// Input Types
// ============================================================================

/**
 * Complete input for querying images
 * Combines all filter options from GetInfiniteImagesOutput
 */
export type ImageQueryInput = {
  // Sorting & Pagination (handled by Feed context)
  sort?: ImageSort;

  // NSFW filtering
  browsingLevel?: number;
  useCombinedNsfwLevel?: boolean;

  // User filtering
  userId?: number;
  username?: string;
  excludedUserIds?: number[];
  followed?: boolean;
  hidden?: boolean;
  currentUserId?: number;
  isModerator?: boolean;

  // Content filtering
  postId?: number;
  postIds?: number[];
  modelId?: number;
  modelVersionId?: number;
  types?: MediaType[];
  tags?: number[];
  excludedTagIds?: number[];
  tools?: number[];
  techniques?: number[];
  baseModels?: string[];

  // Resource filtering
  hideAutoResources?: boolean;
  hideManualResources?: boolean;

  // Metadata filtering
  withMeta?: boolean;
  requiringMeta?: boolean;
  fromPlatform?: boolean;

  // Remix filtering
  remixOfId?: number;
  remixesOnly?: boolean;
  nonRemixesOnly?: boolean;

  // Time filtering
  period?: 'Day' | 'Week' | 'Month' | 'Year' | 'AllTime';

  // Publishing status
  notPublished?: boolean;
  scheduled?: boolean;

  // Moderation
  disablePoi?: boolean;
  disableMinor?: boolean;
  poiOnly?: boolean;
  minorOnly?: boolean;
  blockedFor?: string[];

  // Feature flags (evaluated by caller, not feed)
  enableExistenceCheck?: boolean;

  // Population options (for conditional data fetching)
  include?: Array<
    'tags' |
    'count' |
    'cosmetics' |
    'report' |
    'meta' |
    'tagIds' |
    'profilePictures' |
    'metaSelect'
  >;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a browsing level flag intersects with NSFW levels
 */
export function includesNsfwContent(browsingLevel: number): boolean {
  return (browsingLevel & nsfwBrowsingLevelsFlag) !== 0;
}

/**
 * Convert browsing level flag to array of levels
 */
export function browsingLevelToArray(flag: number): NsfwLevel[] {
  const levels: NsfwLevel[] = [];
  for (const level of allBrowsingLevelsArray) {
    if ((flag & level) !== 0) {
      levels.push(level);
    }
  }
  return levels;
}

/**
 * Get only selectable browsing levels (excludes Blocked)
 */
export function onlySelectableLevels(level?: number): number {
  if (!level) return NsfwLevel.PG;
  // Remove Blocked level from the flag
  return level & ~NsfwLevel.Blocked;
}

/**
 * Snap timestamp to interval for better caching
 * Rounds down to nearest 5 minutes
 */
export function snapToInterval(timestamp: number, intervalMs: number = 5 * 60 * 1000): number {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}
