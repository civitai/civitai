export type MetricEntityType =
  | 'User'
  | 'Model'
  | 'ModelVersion'
  | 'Post'
  | 'Image'
  | 'Collection'
  | 'Tag'
  | 'Article'
  | 'Bounty'
  | 'BountyEntry';

export type MetricType =
  // User metrics
  | 'followerCount'
  | 'followingCount'
  | 'hiddenCount'
  | 'reactionCount'
  | 'articleCount'
  | 'bountyCount'
  // Model/ModelVersion metrics
  | 'downloadCount'
  | 'collectedCount'
  | 'commentCount'
  | 'imageCount'
  | 'ratingCount'
  | 'thumbsUpCount'
  | 'thumbsDownCount'
  // Tipping metrics
  | 'tippedAmount'
  | 'tippedAmountCount'
  | 'tippedCount'
  | 'tipsGivenAmount'
  | 'tipsGivenCount'
  // Reaction metrics
  | 'likeCount'
  | 'dislikeCount'
  | 'heartCount'
  | 'laughCount'
  | 'cryCount'
  // Other metrics
  | 'viewCount'
  | 'itemCount'
  | 'contributorCount'
  | 'favoriteCount'
  | 'trackCount'
  | 'entryCount'
  | 'benefactorCount'
  | 'unitAmount'
  | 'modelCount'
  | 'postCount'
  | 'hideCount';

export type MetricUpdatePayload = Partial<Record<MetricType, number>>;

export interface MetricSignalData {
  entityType: MetricEntityType;
  entityId: number;
  updates: MetricUpdatePayload;
}
