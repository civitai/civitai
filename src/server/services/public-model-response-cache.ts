import { env } from '~/env/server';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// Public-response cache (origin-side cache for GET /api/v1/models/[id]) toggle —
// only populated on Datapacket (see PUBLIC_MODEL_RESPONSE_TTL in the handler).
const publicModelResponseCacheEnabled = () => env.IS_DATAPACKET;

export function publicModelResponseKey(
  modelId: number,
  browsingLevel: number
): RedisKeyTemplateCache {
  // `v2`: bodies whose card images are held to the level. Bump when the body's filtering changes,
  // so entries built by the previous code are not read.
  return `${REDIS_KEYS.CACHES.PUBLIC_MODEL_RESPONSE}:v2:${modelId}:${browsingLevel}`;
}

// Best-effort, fail-open invalidation of the origin-side public response cache for
// GET /api/v1/models/[id] (see the handler). Called from bustMvCache so an
// unpublish / takedown / update / delete drops the cached 200 immediately rather
// than serving stale for up to the cache TTL globally. Busts BOTH browsing-level
// keys the handler can write (all-levels for unrestricted regions, sfw-only for
// region-restricted ones). Deletes the physical key — the handler's read keys off
// key PRESENCE, so a clean delete forces a rebuild. A Redis error here must NOT
// throw into the mutation path, so it is swallowed (the entry otherwise expires
// via its TTL).
export async function bustPublicModelResponseCache(modelId: number | number[]) {
  if (!publicModelResponseCacheEnabled()) return;
  const modelIds = Array.isArray(modelId) ? modelId : [modelId];
  if (modelIds.length === 0) return;
  const keys = modelIds.flatMap((id) => [
    publicModelResponseKey(id, allBrowsingLevelsFlag),
    publicModelResponseKey(id, sfwBrowsingLevelsFlag),
  ]);
  await redis.del(keys).catch(() => undefined);
}
