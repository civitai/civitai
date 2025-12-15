/**
 * Configuration for metric backfill from PostgreSQL to ClickHouse
 *
 * Maps PostgreSQL metric table columns to ClickHouse metricType values
 * following existing ClickHouse naming conventions.
 */

export type MetricMapping = {
  /** PostgreSQL column name */
  pgColumn: string;
  /** ClickHouse metricType value */
  chMetricType: string;
};

export type MetricTableConfig = {
  /** PostgreSQL table name */
  table: string;
  /** ClickHouse entityType value */
  entityType: string;
  /** Primary key field name in PostgreSQL */
  idField: string;
  /** Column to metricType mappings */
  metrics: MetricMapping[];
};

export const metricTableConfigs: Record<string, MetricTableConfig> = {
  ArticleMetric: {
    table: 'ArticleMetric',
    entityType: 'Article',
    idField: 'articleId',
    metrics: [
      { pgColumn: 'likeCount', chMetricType: 'Like' },
      { pgColumn: 'dislikeCount', chMetricType: 'Dislike' },
      { pgColumn: 'laughCount', chMetricType: 'Laugh' },
      { pgColumn: 'cryCount', chMetricType: 'Cry' },
      { pgColumn: 'heartCount', chMetricType: 'Heart' },
      { pgColumn: 'commentCount', chMetricType: 'commentCount' },
      { pgColumn: 'viewCount', chMetricType: 'viewCount' },
      { pgColumn: 'collectedCount', chMetricType: 'collectedCount' },
      { pgColumn: 'tippedCount', chMetricType: 'tippedCount' },
      { pgColumn: 'tippedAmountCount', chMetricType: 'tippedAmount' },
    ],
  },

  BountyMetric: {
    table: 'BountyMetric',
    entityType: 'Bounty',
    idField: 'bountyId',
    metrics: [
      { pgColumn: 'favoriteCount', chMetricType: 'favoriteCount' },
      { pgColumn: 'trackCount', chMetricType: 'trackCount' },
      { pgColumn: 'entryCount', chMetricType: 'entryCount' },
      { pgColumn: 'benefactorCount', chMetricType: 'benefactorCount' },
      { pgColumn: 'unitAmountCount', chMetricType: 'unitAmount' },
      { pgColumn: 'commentCount', chMetricType: 'commentCount' },
    ],
  },

  BountyEntryMetric: {
    table: 'BountyEntryMetric',
    entityType: 'BountyEntry',
    idField: 'bountyEntryId',
    metrics: [
      { pgColumn: 'likeCount', chMetricType: 'Like' },
      { pgColumn: 'dislikeCount', chMetricType: 'Dislike' },
      { pgColumn: 'laughCount', chMetricType: 'Laugh' },
      { pgColumn: 'cryCount', chMetricType: 'Cry' },
      { pgColumn: 'heartCount', chMetricType: 'Heart' },
      { pgColumn: 'unitAmountCount', chMetricType: 'unitAmount' },
      { pgColumn: 'tippedCount', chMetricType: 'tippedCount' },
      { pgColumn: 'tippedAmountCount', chMetricType: 'tippedAmount' },
    ],
  },

  CollectionMetric: {
    table: 'CollectionMetric',
    entityType: 'Collection',
    idField: 'collectionId',
    metrics: [
      { pgColumn: 'followerCount', chMetricType: 'followerCount' },
      { pgColumn: 'itemCount', chMetricType: 'itemCount' },
      { pgColumn: 'contributorCount', chMetricType: 'contributorCount' },
    ],
  },

  ImageMetric: {
    table: 'ImageMetric',
    entityType: 'Image',
    idField: 'imageId',
    metrics: [
      { pgColumn: 'likeCount', chMetricType: 'ReactionLike' },
      { pgColumn: 'dislikeCount', chMetricType: 'ReactionDislike' },
      { pgColumn: 'laughCount', chMetricType: 'ReactionLaugh' },
      { pgColumn: 'cryCount', chMetricType: 'ReactionCry' },
      { pgColumn: 'heartCount', chMetricType: 'ReactionHeart' },
      { pgColumn: 'commentCount', chMetricType: 'Comment' },
      { pgColumn: 'collectedCount', chMetricType: 'Collection' },
      { pgColumn: 'tippedCount', chMetricType: 'tippedCount' },
      { pgColumn: 'tippedAmountCount', chMetricType: 'tippedAmount' },
      { pgColumn: 'viewCount', chMetricType: 'viewCount' },
    ],
  },

  ModelMetric: {
    table: 'ModelMetric',
    entityType: 'Model',
    idField: 'modelId',
    metrics: [
      { pgColumn: 'downloadCount', chMetricType: 'downloadCount' },
      { pgColumn: 'thumbsUpCount', chMetricType: 'thumbsUpCount' },
      { pgColumn: 'thumbsDownCount', chMetricType: 'thumbsDownCount' },
      { pgColumn: 'commentCount', chMetricType: 'commentCount' },
      { pgColumn: 'collectedCount', chMetricType: 'collectedCount' },
      { pgColumn: 'generationCount', chMetricType: 'generationCount' },
      { pgColumn: 'imageCount', chMetricType: 'imageCount' },
      { pgColumn: 'tippedCount', chMetricType: 'tippedCount' },
      { pgColumn: 'tippedAmountCount', chMetricType: 'tippedAmount' },
      { pgColumn: 'earnedAmount', chMetricType: 'earnedAmount' },
      { pgColumn: 'ratingCount', chMetricType: 'ratingCount' },
    ],
  },

  ModelVersionMetric: {
    table: 'ModelVersionMetric',
    entityType: 'ModelVersion',
    idField: 'modelVersionId',
    metrics: [
      { pgColumn: 'downloadCount', chMetricType: 'downloadCount' },
      { pgColumn: 'thumbsUpCount', chMetricType: 'thumbsUpCount' },
      { pgColumn: 'thumbsDownCount', chMetricType: 'thumbsDownCount' },
      { pgColumn: 'commentCount', chMetricType: 'commentCount' },
      { pgColumn: 'collectedCount', chMetricType: 'collectedCount' },
      { pgColumn: 'generationCount', chMetricType: 'generationCount' },
      { pgColumn: 'imageCount', chMetricType: 'imageCount' },
      { pgColumn: 'tippedCount', chMetricType: 'tippedCount' },
      { pgColumn: 'tippedAmountCount', chMetricType: 'tippedAmount' },
      { pgColumn: 'earnedAmount', chMetricType: 'earnedAmount' },
      { pgColumn: 'ratingCount', chMetricType: 'ratingCount' },
    ],
  },

  PostMetric: {
    table: 'PostMetric',
    entityType: 'Post',
    idField: 'postId',
    metrics: [
      { pgColumn: 'likeCount', chMetricType: 'Like' },
      { pgColumn: 'dislikeCount', chMetricType: 'Dislike' },
      { pgColumn: 'laughCount', chMetricType: 'Laugh' },
      { pgColumn: 'cryCount', chMetricType: 'Cry' },
      { pgColumn: 'heartCount', chMetricType: 'Heart' },
      { pgColumn: 'commentCount', chMetricType: 'commentCount' },
      { pgColumn: 'collectedCount', chMetricType: 'collectedCount' },
    ],
  },

  TagMetric: {
    table: 'TagMetric',
    entityType: 'Tag',
    idField: 'tagId',
    metrics: [
      { pgColumn: 'modelCount', chMetricType: 'modelCount' },
      { pgColumn: 'imageCount', chMetricType: 'imageCount' },
      { pgColumn: 'postCount', chMetricType: 'postCount' },
      { pgColumn: 'articleCount', chMetricType: 'articleCount' },
      { pgColumn: 'hiddenCount', chMetricType: 'hiddenCount' },
      { pgColumn: 'followerCount', chMetricType: 'followerCount' },
    ],
  },

  UserMetric: {
    table: 'UserMetric',
    entityType: 'User',
    idField: 'userId',
    metrics: [
      { pgColumn: 'followerCount', chMetricType: 'followerCount' },
      { pgColumn: 'followingCount', chMetricType: 'followingCount' },
      { pgColumn: 'reactionCount', chMetricType: 'reactionCount' },
      { pgColumn: 'hiddenCount', chMetricType: 'hiddenCount' },
      { pgColumn: 'uploadCount', chMetricType: 'uploadCount' },
      { pgColumn: 'reviewCount', chMetricType: 'reviewCount' },
    ],
  },
};

/** List of all available table names for CLI validation */
export const availableTables = Object.keys(metricTableConfigs);

/** Default batch size (ID range) for processing - large for efficiency with big tables */
export const DEFAULT_BATCH_SIZE = 100000;

/** Default concurrency for batch processing */
export const DEFAULT_CONCURRENCY = 5;

/** Backfill version marker */
export const BACKFILL_VERSION = 3;

/** Backfill userId marker */
export const BACKFILL_USER_ID = -1;

/** Target ClickHouse table */
export const CLICKHOUSE_TABLE = 'entityMetricEvents_new';
