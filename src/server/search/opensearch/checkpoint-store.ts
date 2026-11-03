import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { BuildCheckpoint, CheckpointStore } from '~/server/search/opensearch/index-build';

const KEY = REDIS_SYS_KEYS.OPENSEARCH_INDEX_BUILDS.CHECKPOINTS;

/** Build checkpoints in sysRedis, one hash field per alias. Losing one restarts that build. */
export const redisCheckpointStore: CheckpointStore = {
  async get(alias) {
    const raw = await sysRedis.hGet(KEY, alias);
    return raw ? (JSON.parse(raw) as BuildCheckpoint) : null;
  },
  async set(alias, checkpoint) {
    await sysRedis.hSet(KEY, alias, JSON.stringify(checkpoint));
  },
  async clear(alias) {
    await sysRedis.hDel(KEY, alias);
  },
};
