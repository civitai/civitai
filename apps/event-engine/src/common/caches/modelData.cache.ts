import { createCache, CacheContext } from './base';

export type ModelCacheData = {
  modelId: number;
  name: string;
  type: string;
  nsfw: boolean;
  userId: number;
  // Add other model fields as needed
};

/**
 * Cache for model metadata
 * Used to populate documents with model information
 */
export const modelData = createCache<ModelCacheData>({
  redisKey: 'model:data',
  idKey: 'modelId',
  async fetch({ pg }: CacheContext, ids: number[]) {
    const models = await pg.query<ModelCacheData>(
      `SELECT
        id as "modelId",
        name,
        type,
        nsfw,
        "userId"
       FROM "Model"
       WHERE id = ANY($1)`,
      [ids]
    );
    return models;
  },
  ttl: 60 * 60 * 24, // 24 hours
});
