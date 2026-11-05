import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

/** How long a cursor stays resumable after it was last issued or resumed from. */
export const SNAPSHOT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export function createRedisSnapshotStore(): SnapshotStore {
  const key = (digest: string) => `${REDIS_SYS_KEYS.REGISTRY_ADAPTER.SNAPSHOT}:${digest}` as const;
  return {
    async get(digest) {
      return decodeRedisString(await withSysReadDeadline(sysRedis.get(key(digest)))) ?? null;
    },
    async put(digest, value) {
      await sysRedis.set(key(digest), value, { EX: SNAPSHOT_RETENTION_SECONDS });
    },
  };
}
