// Extracted types to break circular dependency between clickhouse/client.ts and jobs/entity-moderation.ts

export type AllModKeys =
  | 'Comment'
  | 'CommentV2'
  | 'User'
  | 'UserProfile'
  | 'Model'
  | 'Post'
  | 'ResourceReview'
  | 'Article'
  | 'Bounty'
  | 'BountyEntry'
  | 'Collection'
  | 'Chat';
