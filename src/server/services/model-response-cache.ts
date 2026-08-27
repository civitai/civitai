import { env } from '~/env/server';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// A leaf module so `nsfwLevels.service` can bust this cache. Living in `model-version.service`
// put it behind an import cycle: that module imports the version moderation adapter, which
// imports `nsfwLevels.service`.

// Public-response cache (origin-side cache for GET /api/v1/models/[id]) toggle —
// only populated on Datapacket (see PUBLIC_MODEL_RESPONSE_TTL in the handler).
const PUBLIC_MODEL_RESPONSE_CACHE_ENABLED = env.IS_DATAPACKET;

// One DEL per key, so a whole cron chunk would otherwise fan out to thousands of concurrent
// commands (`redis.del` splits arrays to avoid CROSSSLOT).
const BUST_CHUNK_SIZE = 200;

export function publicModelResponseKey(
  modelId: number,
  browsingLevel: number
): RedisKeyTemplateCache {
  return `${REDIS_KEYS.CACHES.PUBLIC_MODEL_RESPONSE}:${modelId}:${browsingLevel}`;
}

// Best-effort, fail-open invalidation of the origin-side public response cache for
// GET /api/v1/models/[id] (see the handler). Called from bustMvCache so an
// unpublish / takedown / update / delete drops the cached 200 immediately rather
// than serving stale for up to the cache TTL globally, and from the nsfw-level
// recompute, whose result is embedded in that payload per version. Busts BOTH
// browsing-level keys the handler can write (all-levels for unrestricted regions,
// sfw-only for region-restricted ones). Deletes the physical key — the handler's read
// keys off key PRESENCE, so a clean delete forces a rebuild. A Redis error here must
// NOT throw into the mutation path, so it is swallowed (the entry otherwise expires
// via its TTL).
export async function bustPublicModelResponseCache(modelId: number | number[]) {
  if (!PUBLIC_MODEL_RESPONSE_CACHE_ENABLED) return;
  const modelIds = Array.isArray(modelId) ? modelId : [modelId];
  if (modelIds.length === 0) return;

  for (let i = 0; i < modelIds.length; i += BUST_CHUNK_SIZE) {
    const keys = modelIds
      .slice(i, i + BUST_CHUNK_SIZE)
      .flatMap((id) => [
        publicModelResponseKey(id, allBrowsingLevelsFlag),
        publicModelResponseKey(id, sfwBrowsingLevelsFlag),
      ]);
    await redis.del(keys).catch(() => undefined);
  }
}
