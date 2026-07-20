export enum EntityType {
  User = 'User',
  Model = 'Model',
  ModelVersion = 'ModelVersion',
  Post = 'Post',
  Image = 'Image',
  Collection = 'Collection',
  Tag = 'Tag',
  Article = 'Article',
  Bounty = 'Bounty',
  BountyEntry = 'BountyEntry',
}

export enum MetricType {
  followingCount = 'followingCount',
  followerCount = 'followerCount',
  reactionCount = 'reactionCount',
  hiddenCount = 'hiddenCount',
  uploadCount = 'uploadCount',
  reviewCount = 'reviewCount',
  rating = 'rating',
  ratingCount = 'ratingCount',
  downloadCount = 'downloadCount',
  favoriteCount = 'favoriteCount',
  commentCount = 'commentCount',
  collectedCount = 'collectedCount',
  imageCount = 'imageCount',
  tippedCount = 'tippedCount',
  tippedAmountCount = 'tippedAmountCount',
  generationCount = 'generationCount',
  thumbsUpCount = 'thumbsUpCount',
  thumbsDownCount = 'thumbsDownCount',
  earnedAmount = 'earnedAmount',
  likeCount = 'likeCount',
  dislikeCount = 'dislikeCount',
  laughCount = 'laughCount',
  cryCount = 'cryCount',
  heartCount = 'heartCount',
  viewCount = 'viewCount',
  itemCount = 'itemCount',
  contributorCount = 'contributorCount',
  modelCount = 'modelCount',
  postCount = 'postCount',
  articleCount = 'articleCount',
  hideCount = 'hideCount',
  trackCount = 'trackCount',
  entryCount = 'entryCount',
  benefactorCount = 'benefactorCount',
  unitAmount = 'unitAmount',
}

export interface EntityMetricEvent {
  entityType: EntityType;
  entityId: number;
  userId: number;
  metricType: MetricType;
  metricValue: number;
  createdAt: Date;
}

export interface KafkaEvent {
  topic: string;
  partition: number;
  message: {
    key?: string;
    value: string;
    timestamp?: string;
    offset: string;
  };
}

export interface DebeziumEvent {
  before?: Record<string, any>;
  after?: Record<string, any>;
  op: 'c' | 'u' | 'd' | 'r';
  ts_ms: number;
  transaction?: {
    id: string;
    total_order: number;
    data_collection_order: number;
  };
}

export interface EventListener {
  name: string;
  canHandle(event: KafkaEvent): boolean;
  handle(event: KafkaEvent): Promise<EntityMetricEvent[]>;
}

export interface IndexUpdate {
  entityType: EntityType;
  entityId: number;
  metrics: Partial<Record<MetricType, number>>;
}