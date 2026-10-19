import { createHash } from 'node:crypto';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { modelWithDetailsSelect } from '~/server/selectors/model.selector';

/**
 * Key and bust for the viewer-independent model row behind `model.getById` (the cache itself is in
 * `services/model-detail-cache.service.ts`). Kept apart from the service so the write-side helpers
 * that bust it (`db-lag-helpers`) do not import the read path.
 */

// The entry holds the result of `modelWithDetailsSelect` in the codec's encoding. The shape segment
// changes whenever the select does, so a deploy that adds or drops a field reads its own entries
// and never a row written by the previous build. Bump `CODEC_VERSION` when the encoding changes
// without the select changing.
const CODEC_VERSION = 'v1';
export const MODEL_DETAIL_PUBLIC_SHAPE = `${CODEC_VERSION}-${createHash('sha1')
  .update(JSON.stringify(modelWithDetailsSelect))
  .digest('hex')
  .slice(0, 10)}`;

export function modelDetailPublicCacheKey(modelId: number): RedisKeyTemplateCache {
  return `${REDIS_KEYS.CACHES.MODEL_DETAIL_PUBLIC}:${MODEL_DETAIL_PUBLIC_SHAPE}:${modelId}`;
}

/**
 * Drops the cached model row so the next `model.getById` reads the database. Best-effort: a Redis
 * error is swallowed so it never fails the write that called it; the entry then ages out on its
 * TTL. Deletes the key rather than marking it stale, so no reader can be served the row from
 * before the write once this has returned.
 */
export async function bustModelDetailPublicCache(modelIds: number | number[]) {
  const ids = Array.isArray(modelIds) ? modelIds : [modelIds];
  if (ids.length === 0) return;
  try {
    await redis.del(ids.map(modelDetailPublicCacheKey));
  } catch {
    // Best-effort, see above.
  }
}
