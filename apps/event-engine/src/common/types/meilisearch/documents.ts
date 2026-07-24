// Meilisearch document types - exact structures stored in indexes

// Base types
export interface UserInfo {
  id: number;
  username: string | null;
  deletedAt: Date | null;
  image: string | null;
}

export interface ModelMetrics {
  downloadCount: number;
  favoriteCount: number;
  commentCount: number;
  ratingCount: number;
  rating: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  collectedCount: number;
  tippedAmountCount: number;
}

export interface ImageMetrics {
  reactionCount: number;
  commentCount: number;
  collectedCount: number;
}

// METRICS_MODELS_SEARCH_INDEX document structure (used by getModelsRaw)
export interface ModelRawItem {
  id: number;
  name: string;
  description?: string | null;
  type: string; // ModelType
  poi?: boolean;
  minor?: boolean;
  sfwOnly?: boolean;
  nsfw: boolean;
  nsfwLevel: number;
  allowNoCredit?: boolean;
  allowCommercialUse?: string[]; // CommercialUse[]
  allowDerivatives?: boolean;
  allowDifferentLicense?: boolean;
  status: string;
  createdAt: Date;
  lastVersionAt: Date;
  lastVersionAtUnix?: number;
  publishedAt?: Date | null;
  publishedAtUnix?: number;
  locked: boolean;
  earlyAccessDeadline?: Date | null;
  mode?: string | null;
  availability?: string; // Availability

  // Metrics in rank object
  rank: {
    downloadCount: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
    commentCount: number;
    ratingCount: number;
    rating: number;
    collectedCount: number;
    tippedAmountCount: number;
  };

  // Tags as simple objects
  tagsOnModels: {
    tagId: number;
    name: string;
  }[];

  // Hashes as string array (converted from objects)
  hashes: string[];

  // Model versions with detailed structure
  modelVersions: {
    id: number;
    name: string;
    earlyAccessTimeFrame: number;
    baseModel: string; // BaseModel
    baseModelType: string; // BaseModelType
    createdAt: Date;
    trainingStatus: string;
    trainedWords?: string[];
    vaeId: number | null;
    publishedAt: Date | null;
    status: string; // ModelStatus
    covered: boolean;
  }[];

  // User information (augmented with cache data)
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
    profilePicture?: {
      id: number;
      name: string;
      url: string;
      nsfw: boolean;
      width: number;
      height: number;
      hash: string;
      type: string;
      metadata: Record<string, any>;
      createdAt: Date;
      userId: number;
    } | null;
    cosmetics?: {
      cosmeticId: number;
      data: Record<string, any>;
      cosmetic: {
        id: number;
        name: string;
        type: string; // CosmeticType
        source: string; // CosmeticSource
        data: Record<string, any>;
      };
    }[];
  };

  // Optional cosmetic decoration
  cosmetic?: {
    id: number;
    type: string;
    name: string;
    data: Record<string, any>;
    claimKey?: string;
  } | null;

  // Allow additional fields for extensibility
  [key: string]: any;
}

// METRICS_IMAGES_SEARCH_INDEX document structure (used by getImagesFromSearchPreFilter)
export interface ImageMetricsSearchIndexRecord {
  // Base image properties
  id: number;
  index: number;
  postId: number;
  url: string;
  nsfwLevel: number;
  aiNsfwLevel: number;
  combinedNsfwLevel: number; // calculated field
  width: number;
  height: number;
  hash: string;
  hideMeta: boolean;
  sortAt: Date;
  sortAtUnix: number; // calculated field
  type: string;
  userId: number;
  publishedAt?: Date;
  publishedAtUnix?: number; // calculated field
  existedAtUnix: number; // calculated field
  hasMeta: boolean;
  hasPositivePrompt?: boolean;
  onSite: boolean;
  postedToId?: number;
  needsReview: string | null;
  minor?: boolean;
  poi: boolean;
  acceptableMinor?: boolean;
  blockedFor: string | null; // BlockedReason
  remixOfId?: number | null;
  availability?: string; // Availability

  // Model associations
  baseModel: string;
  modelVersionIds: number[]; // auto-detected
  modelVersionIdsManual: number[]; // manually assigned

  // Tools, techniques, and tags
  toolIds: number[];
  techniqueIds: number[];
  tagIds: number[];

  // Metrics
  reactionCount: number;
  commentCount: number;
  collectedCount: number;

  // Flags object for moderation
  flags?: {
    promptNsfw?: boolean;
    [key: string]: any;
  };

  // Allow additional fields for extensibility
  [key: string]: any;
}

// Full feed result with stats (what getImagesFromSearchPreFilter returns)
export interface ImageFeedResult extends ImageMetricsSearchIndexRecord {
  // Detailed stats object (added by getImagesFromSearchPreFilter)
  stats: {
    likeCountAllTime: number;
    laughCountAllTime: number;
    heartCountAllTime: number;
    cryCountAllTime: number;
    commentCountAllTime: number;
    collectedCountAllTime: number;
    tippedAmountCountAllTime: number;
    dislikeCountAllTime: number;
    viewCountAllTime: number;
  };
}

// Response types
export interface ModelFeedResponse {
  items: ModelRawItem[];
  nextCursor?: string | bigint | number | Date;
  isPrivate: boolean;
}

export interface ImageFeedResponse {
  data: ImageFeedResult[];
  nextCursor?: number;
}

