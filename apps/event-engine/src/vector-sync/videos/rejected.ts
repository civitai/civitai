import { config } from '@/config';
import { createEngineCluster } from '@/services/redis-cluster-client';
import type { RejectedMemo } from '../domain/sync';
import { vectorSyncMetrics } from '../metrics';

/** Long enough that a refresh walk stops paying for the same clip; short enough to retry a worker fix. */
export const REJECTED_TTL_SECONDS = 7 * 24 * 3600;

type Kv = {
  mGet(keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
};

/** One key per id under the collection's hash tag, so an MGET stays on one cluster slot. */
export function kvRejectedMemo(kv: Kv, collection: string): RejectedMemo {
  const key = (id: number) => `vector-sync:{rejected:${collection}}:${id}`;
  return {
    has: async (docs) => {
      if (!docs.length) return new Set();
      const stored = await kv.mGet(docs.map(([id]) => key(id)));
      const held = new Set(docs.filter(([, hash], i) => stored[i] === hash).map(([id]) => id));
      if (held.size)
        vectorSyncMetrics.skipped.inc({ domain: 'video', reason: 'media-refused' }, held.size);
      return held;
    },
    add: async (docs) => {
      vectorSyncMetrics.points.inc({ domain: 'video', outcome: 'refused' }, docs.length);
      for (const [id, hash] of docs) await kv.set(key(id), hash, { EX: REJECTED_TTL_SECONDS });
    },
  };
}

export async function redisRejectedMemo(): Promise<RejectedMemo> {
  const redis = createEngineCluster(new URL(config.redis.url));
  await redis.connect();
  return kvRejectedMemo(redis, config.vectorSync.videoCollection);
}
