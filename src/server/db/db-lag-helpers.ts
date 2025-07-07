import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';

type LaggingType =
  | 'model'
  | 'modelVersion'
  | 'commentModel'
  | 'resourceReview'
  | 'post'
  | 'postImages'
  | 'article';

export async function getDbWithoutLag(type: LaggingType, id?: number) {
  if (env.REPLICATION_LAG_DELAY <= 0 || !id) return dbRead;
  const value = await redis.get(`${REDIS_KEYS.LAG_HELPER}:${type}:${id}`);
  if (value) return dbWrite;
  return dbRead;
}

export async function preventReplicationLag(type: LaggingType, id?: number) {
  if (env.REPLICATION_LAG_DELAY <= 0 || !id) return;
  await redis.set(`${REDIS_KEYS.LAG_HELPER}:${type}:${id}`, 'true', {
    EX: env.REPLICATION_LAG_DELAY,
  });
}
