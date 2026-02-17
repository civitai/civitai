export const OPENSEARCH_METRICS_IMAGES_INDEX = 'metrics_images_v1';

export const metricsImagesSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
};

export const metricsImagesMappings = {
  properties: {
    id: { type: 'integer' },
    index: { type: 'integer' },
    postId: { type: 'integer' },
    url: { type: 'keyword' },
    nsfwLevel: { type: 'integer' },
    aiNsfwLevel: { type: 'integer' },
    combinedNsfwLevel: { type: 'integer' },
    nsfwLevelLocked: { type: 'boolean' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    hash: { type: 'keyword' },
    hideMeta: { type: 'boolean' },
    sortAt: { type: 'date' },
    sortAtUnix: { type: 'long' },
    type: { type: 'keyword' },
    userId: { type: 'integer' },
    publishedAtUnix: { type: 'long' },
    existedAtUnix: { type: 'long' },
    hasMeta: { type: 'boolean' },
    hasPositivePrompt: { type: 'boolean' },
    onSite: { type: 'boolean' },
    postedToId: { type: 'integer' },
    needsReview: { type: 'keyword' },
    minor: { type: 'boolean' },
    poi: { type: 'boolean' },
    acceptableMinor: { type: 'boolean' },
    blockedFor: { type: 'keyword' },
    remixOfId: { type: 'integer' },
    availability: { type: 'keyword' },
    baseModel: { type: 'keyword' },
    modelVersionIds: { type: 'integer' },
    modelVersionIdsManual: { type: 'integer' },
    toolIds: { type: 'integer' },
    techniqueIds: { type: 'integer' },
    tagIds: { type: 'integer' },
    reactionCount: { type: 'integer' },
    commentCount: { type: 'integer' },
    collectedCount: { type: 'integer' },
    flags: {
      properties: {
        promptNsfw: { type: 'boolean' },
      },
    },
  },
} as const;
