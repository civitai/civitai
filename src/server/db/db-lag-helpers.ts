import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { redis, REDIS_KEYS } from '~/server/redis/client';

type LaggingType =
  | 'model'
  | 'modelVersion'
  | 'commentModel'
  | 'resourceReview'
  | 'post'
  | 'postImages'
  | 'article'
  | 'imageResource'
  | 'notification';

function lagKey(type: LaggingType, id: number | string) {
  return `${REDIS_KEYS.LAG_HELPER}:${type}:${id}` as const;
}

export async function getDbWithoutLag(type: LaggingType, id?: number | string) {
  if (env.REPLICATION_LAG_DELAY <= 0 || id === undefined || id === null) return dbRead;
  const value = await redis.get(lagKey(type, id));
  if (value) return dbWrite;
  return dbRead;
}

export async function preventReplicationLag(type: LaggingType, id?: number | string) {
  if (env.REPLICATION_LAG_DELAY <= 0 || id === undefined || id === null) return;
  await redis.set(lagKey(type, id), 'true', { EX: env.REPLICATION_LAG_DELAY });
}

// Batch variant: routes the whole batch to dbWrite when ANY id has the lag flag.
// Correctness over marginal perf — batches are typically small and a full-primary
// read is preferable to splitting queries.
export async function getDbWithoutLagBatch(type: LaggingType, ids: (number | string)[]) {
  if (env.REPLICATION_LAG_DELAY <= 0 || ids.length === 0) return dbRead;
  const values = await Promise.all(ids.map((id) => redis.get(lagKey(type, id))));
  return values.some(Boolean) ? dbWrite : dbRead;
}

export async function preventReplicationLagBatch(type: LaggingType, ids: (number | string)[]) {
  if (env.REPLICATION_LAG_DELAY <= 0 || ids.length === 0) return;
  await Promise.all(
    ids.map((id) => redis.set(lagKey(type, id), 'true', { EX: env.REPLICATION_LAG_DELAY }))
  );
}

// Same as getDbWithoutLag / getDbWithoutLagBatch but for the notifDb pool.
export async function getNotifDbWithoutLag(type: LaggingType, id?: number | string) {
  if (env.REPLICATION_LAG_DELAY <= 0 || id === undefined || id === null) return notifDbRead;
  const value = await redis.get(lagKey(type, id));
  if (value) return notifDbWrite;
  return notifDbRead;
}
