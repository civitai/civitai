// Define our own EntityMetric types instead of using generated Prisma enums
// These are no longer in the DB, so we maintain them here

/**
 * Entity types that support metric tracking
 */
// @dev: Do we really need to define them this way with key and value repetition? Whats the difference between this and a TS enum?
export const EntityMetric_EntityType = {
  Image: 'Image',
  Post: 'Post',
  Model: 'Model',
  ModelVersion: 'ModelVersion',
  Collection: 'Collection',
  User: 'User',
} as const;

export type EntityMetric_EntityType_Type = (typeof EntityMetric_EntityType)[keyof typeof EntityMetric_EntityType];

/**
 * Metric types that can be tracked
 */
export const EntityMetric_MetricType = {
  ReactionLike: 'ReactionLike',
  ReactionHeart: 'ReactionHeart',
  ReactionLaugh: 'ReactionLaugh',
  ReactionCry: 'ReactionCry',
  Comment: 'Comment',
  Collection: 'Collection',
  Buzz: 'Buzz',
  Hide: 'Hide',
  View: 'View',
  ThumbsUp: 'ThumbsUp',
  ThumbsDown: 'ThumbsDown',
  Tip: 'Tip',
  Download: 'Download',
  Generation: 'Generation',
  Favorite: 'Favorite',
  Image: 'Image',
  Earned: 'Earned',
  Follow: 'Follow',
} as const;

export type EntityMetric_MetricType_Type = (typeof EntityMetric_MetricType)[keyof typeof EntityMetric_MetricType];

/**
 * Entity types that support metric tracking via updateEntityMetric
 */
export const METRIC_SUPPORTED_ENTITY_TYPES: readonly EntityMetric_EntityType_Type[] = Object.values(EntityMetric_EntityType);

/**
 * Check if a string is a supported metric entity type
 */
export function isMetricSupportedEntityType(
  entityType: string
): entityType is EntityMetric_EntityType_Type {
  return METRIC_SUPPORTED_ENTITY_TYPES.includes(entityType as EntityMetric_EntityType_Type);
}

/**
 * Maps string entity types to EntityMetric_EntityType_Type
 * Returns null if not supported
 */
export function toMetricEntityType(entityType: string): EntityMetric_EntityType_Type | null {
  if (isMetricSupportedEntityType(entityType)) {
    return entityType;
  }
  return null;
}
