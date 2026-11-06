import { createHash } from 'node:crypto';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { retainLatest } from '~/server/registry-adapter/cursor';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

/** How long a cursor stays resumable after it was last issued or resumed from. */
export const SNAPSHOT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Snapshots in system Redis, at most `STATES_KEPT_PER_STREAM` per stream.
 *
 * The per-stream list is read and rewritten without a transaction, so two subscriptions of one
 * stream writing at once can each drop the other's newest digest from the list. Both outcomes
 * are safe: a digest left off the list is still deleted by its TTL, and a digest deleted early
 * only turns its cursor into `cursor_expired` (a re-snapshot).
 */
export function createRedisSnapshotStore(): SnapshotStore {
  const key = (digest: string) => `${REDIS_SYS_KEYS.REGISTRY_ADAPTER.SNAPSHOT}:${digest}` as const;
  const listKey = (stream: string) =>
    `${REDIS_SYS_KEYS.REGISTRY_ADAPTER.STREAM_STATES}:${createHash('sha256')
      .update(stream)
      .digest('hex')
      .slice(0, 32)}` as const;
  return {
    async get(digest) {
      return decodeRedisString(await withSysReadDeadline(sysRedis.get(key(digest)))) ?? null;
    },
    async put(digest, value, stream) {
      await sysRedis.set(key(digest), value, { EX: SNAPSHOT_RETENTION_SECONDS });
      const states = listKey(stream);
      const current = (await withSysReadDeadline(sysRedis.lRange(states, 0, -1))).map((d) =>
        String(decodeRedisString(d))
      );
      const { list, evicted } = retainLatest(current, digest);
      if (current[0] !== digest || evicted.length > 0) {
        await sysRedis.del(states);
        // LPUSH of the reversed list leaves it newest first.
        await sysRedis.lPush(states, [...list].reverse());
        await sysRedis.expire(states, SNAPSHOT_RETENTION_SECONDS);
      }
      for (const old of evicted) await sysRedis.del(key(old));
    },
  };
}
