import { createLagTracker } from '@civitai/db';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';

// Shared recent-write tracker (@civitai/db). Redis is injected as the flag store — the package stays
// redis-agnostic. The Flipt global kill-switch + per-entity key scheme below stay app-side (domain).
const lagTracker = createLagTracker<RedisKeyTemplateCache>({
  store: redis,
  delaySeconds: env.REPLICATION_LAG_DELAY,
});

type LaggingType =
  | 'model'
  | 'modelVersion'
  | 'commentModel'
  | 'resourceReview'
  | 'post'
  | 'postImages'
  | 'article'
  | 'imageResource'
  | 'notification'
  | 'userTrainingModels'
  | 'userArticles'
  | 'userApiKeys'
  | 'collection'
  | 'userCollections';

function lagKey(type: LaggingType, id: number | string) {
  return `${REDIS_KEYS.LAG_HELPER}:${type}:${id}` as RedisKeyTemplateCache;
}

function isHighReplicationLagMode() {
  // Synchronous eval — null when Flipt hasn't initialized yet; treat that as off.
  return isFliptSync(FLIPT_FEATURE_FLAGS.HIGH_REPLICATION_LAG_MODE) === true;
}

// Called with (type, id): returns dbWrite only when a recent write flagged
// that specific entity in Redis. The Flipt flag does NOT override this path —
// per-id is already precise, and flipping every targeted reader to primary
// would flood it.
// Called with no args: falls back to the HIGH_REPLICATION_LAG_MODE Flipt flag
// as a global kill-switch for RAW reads that have no per-id flagging (e.g.
// reaction toggles).
export async function getDbWithoutLag(type?: LaggingType, id?: number | string) {
  if (env.REPLICATION_LAG_DELAY <= 0) return dbRead;
  if (type === undefined || id === undefined || id === null) {
    return isHighReplicationLagMode() ? dbWrite : dbRead;
  }
  return (await lagTracker.isStale(lagKey(type, id))) ? dbWrite : dbRead;
}

export async function preventReplicationLag(type: LaggingType, id?: number | string) {
  if (id === undefined || id === null) return;
  await lagTracker.markFresh(lagKey(type, id));
}

// Batch variant: routes the whole batch to dbWrite when ANY id has the lag flag.
// Correctness over marginal perf — batches are typically small and a full-primary
// read is preferable to splitting queries. Flipt kill-switch intentionally does
// not override the batch path — callers with ids are precise.
export async function getDbWithoutLagBatch(type: LaggingType, ids: (number | string)[]) {
  if (env.REPLICATION_LAG_DELAY <= 0 || ids.length === 0) return dbRead;
  const stale = await Promise.all(ids.map((id) => lagTracker.isStale(lagKey(type, id))));
  return stale.some(Boolean) ? dbWrite : dbRead;
}

export async function preventReplicationLagBatch(type: LaggingType, ids: (number | string)[]) {
  if (env.REPLICATION_LAG_DELAY <= 0 || ids.length === 0) return;
  await Promise.all(ids.map((id) => lagTracker.markFresh(lagKey(type, id))));
}

// Readers route via getDbWithoutLag('model', modelId) for model-page queries AND
// getDbWithoutLag('modelVersion', versionId) for direct version lookups. Any
// mutation touching a ModelVersion row must flag both so either access path
// catches the lag window.
export async function preventModelVersionLagBatch(
  modelIds: number | number[],
  versionIds: number | number[]
) {
  const mIds = Array.isArray(modelIds) ? modelIds : [modelIds];
  const vIds = Array.isArray(versionIds) ? versionIds : [versionIds];
  await Promise.all([
    preventReplicationLagBatch('model', mIds),
    preventReplicationLagBatch('modelVersion', vIds),
  ]);
}

export const preventModelVersionLag = (modelId: number, versionId: number) =>
  preventModelVersionLagBatch(modelId, versionId);
