import { config } from '@/config';
import { createEngineCluster } from '@/services/redis-cluster-client';
import { logger } from '@/utils/logger';
import type { RejectedMemo } from '../domain/sync';
import { vectorSyncMetrics } from '../metrics';

/** Long enough that refresh walks stop paying for the same clip; short enough to retry a worker fix. */
export const REJECTED_TTL_SECONDS = 3 * 24 * 3600;

type Kv = {
  mGet(keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
};

/**
 * One key per id under the collection's hash tag, so an MGET stays on one cluster slot. Fails open:
 * a Redis error re-sends a clip (a paid retry) rather than failing the lane's flush.
 */
export function kvRejectedMemo(kv: Kv, collection: string): RejectedMemo {
  const key = (id: number) => `vector-sync:{rejected:${collection}}:${id}`;
  return {
    has: async (docs) => {
      if (!docs.length) return new Set();
      const stored = await kv.mGet(docs.map(([id]) => key(id))).catch((err) => {
        logger.warn({ err }, 'video-sync: refused-media memo unreadable; sending all');
        return [] as Array<string | null>;
      });
      const held = new Set(docs.filter(([, hash], i) => stored[i] === hash).map(([id]) => id));
      if (held.size)
        vectorSyncMetrics.skipped.inc({ domain: 'video', reason: 'media-refused' }, held.size);
      return held;
    },
    add: async (docs) => {
      vectorSyncMetrics.points.inc({ domain: 'video', outcome: 'refused' }, docs.length);
      await Promise.all(
        docs.map(([id, hash]) => kv.set(key(id), hash, { EX: REJECTED_TTL_SECONDS }))
      ).catch((err) => logger.warn({ err }, 'video-sync: refused-media memo not written'));
    },
  };
}

export async function redisRejectedMemo(): Promise<RejectedMemo> {
  const redis = createEngineCluster(new URL(config.redis.url));
  await redis.connect();
  return {
    ...kvRejectedMemo(redis, config.vectorSync.videoCollection),
    close: async () => void (await redis.quit().catch(() => undefined)),
  };
}
